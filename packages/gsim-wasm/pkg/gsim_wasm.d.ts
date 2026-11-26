/* tslint:disable */
/* eslint-disable */

/**
 * Adds a block to `model_json` from `spec_json` (matching `NewBlockSpec`'s fields). Returns
 * `{"model": <updated Model JSON>, "block_id": "<assigned id>"}`.
 */
export function addBlock(model_json: string, spec_json: string): string;

/**
 * Adds a model-level parameter. Returns updated `Model` JSON.
 */
export function addModelParam(model_json: string, name: string, value_json: string): string;

/**
 * Adds a reusable SPICE `.SUBCKT` definition to `model_json`.
 *
 * **Shared JSON contract** (identical to `gsim-py`'s `add_subckt_def`): `def_json` is a
 * `SubcktDef` — `{"id", "name", "ports": [{"id", "kind"}], "params"?, "blocks"?, "wires"?,
 * "instances"?: [{"id", "def_ref", "connections"?, "params"?}]}`. Returns
 * `{"model": <updated Model JSON>, "def_id": "<id>"}`, mirroring `addBlock`'s
 * `{"model", "block_id"}` shape. Throws with the real error message on an invalid id/port
 * kind, a duplicate def id, or a cyclic `def_ref` graph (the thrown message names the actual
 * cycle, e.g. `"Cyclic SubcktDef reference: a -> b -> a"`).
 */
export function addSubcktDef(model_json: string, def_json: string): string;

/**
 * Arranges every block via `gsim_core::layout::layered_layout`. `bbox_map_json` is
 * `{"<block_id>": [w, h], ...}` -- the caller has already evaluated each block's GSF v2
 * contract to get its bbox; this function doesn't know about contracts. Missing block ids
 * default to `(0, 0)`, never error. Returns updated `Model` JSON.
 */
export function autoArrange(model_json: string, bbox_map_json: string, column_gap: bigint, row_gap: bigint): string;

/**
 * What this engine can compile, as JSON — see [`gsim_core::compile::capabilities`].
 *
 * # Why a front end needs this from the compiler and not from a file
 *
 * The editor used to keep its own list of supported types and their parameters. It drifted
 * until **none of the 143 catalogue types matched it**, because the two sides spelled type
 * names differently, so every block on every sheet reported "not supported by the simulator".
 * The direction was fixed then: the engine declares, the front end renders.
 *
 * `gsim-py` has exposed this since that fix; this binding did not, so a browser-hosted editor
 * could compile a document but could not ask what was compilable — and had to be handed a
 * generated JSON file instead, checked into its own repository with a drift job to notice when
 * it went stale. A generated file with a drift job is a copy with an alarm on it. This is the
 * call that makes the copy unnecessary.
 *
 * The manifest carries `universal_types` as well as `types`: the components the *editor* owns
 * rather than any library — Goto/From, a ground, a wire junction, a scope. A palette that
 * filters on engine support must not filter those out, because no engine's catalogue gets to
 * withhold them (see [`gsim_core::compile::spec::is_universal`] and decision 0006).
 */
export function capabilities(): string;

/**
 * The component library: everything a front end needs to draw a palette, plus whether this
 * engine can compile each component — see [`gsim_core::compile::library`].
 *
 * The same drift story as [`capabilities`], one layer up and with a worse symptom. The editor
 * kept its own catalogue beside this one — labels, port geometry, parameter names and defaults
 * — and the two disagreed until a switch's parameters could not agree on whether they were
 * resistances or conductances. There is one description now, and it is this one.
 */
export function catalog(): string;

/**
 * Compiles a `Model` into netlist text for `target` (currently only `"general-simulator"`).
 *
 * **Shared JSON contract** (identical to `gsim-py`'s `compile`): returns
 * `{"netlist": "<text>", "notes": [...], "provenance": {"elements": [...], "nets": [...]},
 * "code_build": {"steps": [...]} | null, "params": {"<name>": <resolved value>}}`;
 * throws a real JS `Error` carrying the compiler's own message on failure. See
 * `gsim_core::compile::provenance` for the provenance shape and why it is carried rather than
 * re-derived on the JS side.
 */
export function compile(model_json: string, target: string): string;

/**
 * Connects two block ports. `from_json`/`to_json` are `{"block":"...","port":"..."}`,
 * `opts_json` matches `ConnectOptions` (all fields optional -- `"{}"` is a valid default).
 * Returns `{"model": <updated Model JSON>, "wire_id": "<assigned id>"}`.
 *
 * The thrown `Error`'s message clearly states which failure case occurred (cross-paradigm /
 * dangling endpoint / duplicate id / port incompatibility) -- see
 * `gsim_core::document::BuilderError`'s `Display` impl -- so the frontend can distinguish a
 * cross-paradigm attempt (which needs immediate red-X feedback per
 * `docs/specs/gsim-sch-format.md` §8.3) from every other failure.
 *
 * A §8.1/§8.2 port-kind rejection additionally embeds the **same reason token
 * `apps/frontend/src/canvas/port-compat.ts`'s own `canConnect` returns** -- `reserved-kind`,
 * `kind-mismatch`, `fan-in-on-signal` or `dim-mismatch` -- so the canvas's existing
 * reject-flash branching needs no new vocabulary to handle a rejection that came from this
 * crate instead.
 *
 * `contractsJson` is optional (pass `undefined`/`null` to omit) and is a
 * `{"<block type>": <ComponentContract>}` object -- the same contract shape
 * `evaluateComponent` takes. The frontend already holds exactly this per block type in its own
 * catalogue, and passing it lets `connect` resolve each endpoint's real `kind` and `dim` from
 * the block's own `params`, which is what makes `kind-mismatch` exact for ordinary components
 * and `dim-mismatch` possible at all -- i.e. what makes this the same check `canConnect`
 * performs, rather than a coarser one. Omitting it changes nothing that used to work: an
 * unregistered type keeps the block-`domain`-based approximation. See
 * `gsim_core::document::port_compat` for exactly what each source of truth can decide.
 */
export function connect(model_json: string, from_json: string, to_json: string, kind: string, opts_json: string, contracts_json?: string | null): string;

/**
 * Parses `contract_json` as a `ComponentContract` and `params_json` as a JSON object of
 * parameter values, evaluates it, and returns the resulting `EvaluatedSymbol` as JSON.
 */
export function evaluateComponent(contract_json: string, params_json: string): string;

/**
 * Instantiates an existing `SubcktDef` as a top-level `spice-subckt` block.
 *
 * **Shared JSON contract** (identical to `gsim-py`'s `instantiate_subckt`): `spec_json` is
 * `{"def_ref", "position": [x, y], "rotation"?, "domain"?, "fidelity"?, "mirror"?, "params"?,
 * "label"?, "comment_before"?, "comment_after"?, "id"?}`. Returns `{"model": <updated Model JSON>, "block_id": "<assigned id>"}`,
 * the same shape `addBlock` returns. The created block's wireable ports are exactly the
 * referenced def's `ports[].id` list — wire them with ordinary `connect` calls.
 */
export function instantiateSubckt(model_json: string, spec_json: string): string;

/**
 * `blocks_json` is `[{"id":"...","w":..,"h":..}, ...]`, `edges_json` is
 * `[["from_id","to_id"], ...]`. Returns `{"<block_id>": [x, y], ...}`.
 */
export function layeredLayout(blocks_json: string, edges_json: string, column_gap: bigint, row_gap: bigint, grid: bigint): string;

/**
 * Parses `json` via `GsimSchDocument::from_json` (rejects a non-v2 `schema_version` with a
 * clear message) and returns canonical re-serialized JSON.
 */
export function loadDocument(json: string): string;

/**
 * Returns a fresh, empty `Model` as JSON. Cannot fail.
 */
export function newModel(id: string, name: string, grid: bigint): string;

/**
 * `existing_json` is a JSON array of `{"x":..,"y":..,"w":..,"h":..}`; `axis` is `"horizontal"`
 * or `"vertical"`. Returns `[x, y]` as JSON.
 */
export function placeWithoutOverlap(existing_json: string, w: bigint, h: bigint, desired_x: bigint, desired_y: bigint, axis: string, margin: bigint, grid: bigint): string;

/**
 * Removes a block (and cascades wire deletion) from `model_json`. Returns updated `Model` JSON.
 */
export function removeBlock(model_json: string, block_id: string): string;

/**
 * Wraps a `Model` JSON into `{"schema_version": 2, "model": ...}`, pretty-printed.
 */
export function saveDocument(model_json: string): string;

/**
 * Sets a block parameter. Errors if `block_id` doesn't exist. Returns updated `Model` JSON.
 */
export function setParam(model_json: string, block_id: string, name: string, value_json: string): string;

/**
 * Returns a JSON array of `ValidationFailure` (`{"parameter":..., "message":...}`); an empty
 * array means every parameter with a `validate` rule passed. Only errors on malformed input
 * JSON -- validation failures themselves are reported in the returned array, never as a thrown
 * error.
 */
export function validateParameters(contract_json: string, params_json: string): string;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly addBlock: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly addModelParam: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly addSubcktDef: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly autoArrange: (a: number, b: number, c: number, d: number, e: bigint, f: bigint) => [number, number, number, number];
    readonly capabilities: () => [number, number];
    readonly catalog: () => [number, number];
    readonly compile: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly connect: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number) => [number, number, number, number];
    readonly evaluateComponent: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly instantiateSubckt: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly layeredLayout: (a: number, b: number, c: number, d: number, e: bigint, f: bigint, g: bigint) => [number, number, number, number];
    readonly loadDocument: (a: number, b: number) => [number, number, number, number];
    readonly newModel: (a: number, b: number, c: number, d: number, e: bigint) => [number, number];
    readonly placeWithoutOverlap: (a: number, b: number, c: bigint, d: bigint, e: bigint, f: bigint, g: number, h: number, i: bigint, j: bigint) => [number, number, number, number];
    readonly removeBlock: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly saveDocument: (a: number, b: number) => [number, number, number, number];
    readonly setParam: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
    readonly validateParameters: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
