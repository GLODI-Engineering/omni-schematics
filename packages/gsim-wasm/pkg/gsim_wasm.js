/* @ts-self-types="./gsim_wasm.d.ts" */

/**
 * Adds a block to `model_json` from `spec_json` (matching `NewBlockSpec`'s fields). Returns
 * `{"model": <updated Model JSON>, "block_id": "<assigned id>"}`.
 * @param {string} model_json
 * @param {string} spec_json
 * @returns {string}
 */
export function addBlock(model_json, spec_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(spec_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.addBlock(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Adds a model-level parameter. Returns updated `Model` JSON.
 * @param {string} model_json
 * @param {string} name
 * @param {string} value_json
 * @returns {string}
 */
export function addModelParam(model_json, name, value_json) {
    let deferred5_0;
    let deferred5_1;
    try {
        let ptr0, len0, ptr1, len1, ptr2, len2;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.addModelParam(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

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
 * @param {string} model_json
 * @param {string} def_json
 * @returns {string}
 */
export function addSubcktDef(model_json, def_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(def_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.addSubcktDef(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Arranges every block via `gsim_core::layout::layered_layout`. `bbox_map_json` is
 * `{"<block_id>": [w, h], ...}` -- the caller has already evaluated each block's GSF v2
 * contract to get its bbox; this function doesn't know about contracts. Missing block ids
 * default to `(0, 0)`, never error. Returns updated `Model` JSON.
 * @param {string} model_json
 * @param {string} bbox_map_json
 * @param {bigint} column_gap
 * @param {bigint} row_gap
 * @returns {string}
 */
export function autoArrange(model_json, bbox_map_json, column_gap, row_gap) {
    let deferred6_0;
    let deferred6_1;
    try {
        const val3 = BigInt.asIntN(64, column_gap);
        const val4 = BigInt.asIntN(64, row_gap);
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(bbox_map_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.autoArrange(ptr0, len0, ptr1, len1, val3, val4);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

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
 * @returns {string}
 */
export function capabilities() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.capabilities();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The component library: everything a front end needs to draw a palette, plus whether this
 * engine can compile each component — see [`gsim_core::compile::library`].
 *
 * The same drift story as [`capabilities`], one layer up and with a worse symptom. The editor
 * kept its own catalogue beside this one — labels, port geometry, parameter names and defaults
 * — and the two disagreed until a switch's parameters could not agree on whether they were
 * resistances or conductances. There is one description now, and it is this one.
 * @returns {string}
 */
export function catalog() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.catalog();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * Compiles a `Model` into netlist text for `target` (currently only `"general-simulator"`).
 *
 * **Shared JSON contract** (identical to `gsim-py`'s `compile`): returns
 * `{"netlist": "<text>", "notes": [...], "provenance": {"elements": [...], "nets": [...]},
 * "code_build": {"steps": [...]} | null, "params": {"<name>": <resolved value>}}`;
 * throws a real JS `Error` carrying the compiler's own message on failure. See
 * `gsim_core::compile::provenance` for the provenance shape and why it is carried rather than
 * re-derived on the JS side.
 * @param {string} model_json
 * @param {string} target
 * @returns {string}
 */
export function compile(model_json, target) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.compile(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

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
 * @param {string} model_json
 * @param {string} from_json
 * @param {string} to_json
 * @param {string} kind
 * @param {string} opts_json
 * @param {string | null} [contracts_json]
 * @returns {string}
 */
export function connect(model_json, from_json, to_json, kind, opts_json, contracts_json) {
    let deferred8_0;
    let deferred8_1;
    try {
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(from_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(to_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passStringToWasm0(kind, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len3 = WASM_VECTOR_LEN;
            ptr4 = passStringToWasm0(opts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len4 = WASM_VECTOR_LEN;
            ptr5 = isLikeNone(contracts_json) ? 0 : passStringToWasm0(contracts_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len5 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr5) { wasm.__wbindgen_free(ptr5, len5 * 1, 1); }
            if (ptr4) { wasm.__wbindgen_free(ptr4, len4 * 1, 1); }
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.connect(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5);
        var ptr7 = ret[0];
        var len7 = ret[1];
        if (ret[3]) {
            ptr7 = 0; len7 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred8_0 = ptr7;
        deferred8_1 = len7;
        return getStringFromWasm0(ptr7, len7);
    } finally {
        wasm.__wbindgen_free(deferred8_0, deferred8_1, 1);
    }
}

/**
 * Parses `contract_json` as a `ComponentContract` and `params_json` as a JSON object of
 * parameter values, evaluates it, and returns the resulting `EvaluatedSymbol` as JSON.
 * @param {string} contract_json
 * @param {string} params_json
 * @returns {string}
 */
export function evaluateComponent(contract_json, params_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(contract_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.evaluateComponent(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Instantiates an existing `SubcktDef` as a top-level `spice-subckt` block.
 *
 * **Shared JSON contract** (identical to `gsim-py`'s `instantiate_subckt`): `spec_json` is
 * `{"def_ref", "position": [x, y], "rotation"?, "domain"?, "fidelity"?, "mirror"?, "params"?,
 * "label"?, "comment_before"?, "comment_after"?, "id"?}`. Returns `{"model": <updated Model JSON>, "block_id": "<assigned id>"}`,
 * the same shape `addBlock` returns. The created block's wireable ports are exactly the
 * referenced def's `ports[].id` list — wire them with ordinary `connect` calls.
 * @param {string} model_json
 * @param {string} spec_json
 * @returns {string}
 */
export function instantiateSubckt(model_json, spec_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(spec_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.instantiateSubckt(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * `blocks_json` is `[{"id":"...","w":..,"h":..}, ...]`, `edges_json` is
 * `[["from_id","to_id"], ...]`. Returns `{"<block_id>": [x, y], ...}`.
 * @param {string} blocks_json
 * @param {string} edges_json
 * @param {bigint} column_gap
 * @param {bigint} row_gap
 * @param {bigint} grid
 * @returns {string}
 */
export function layeredLayout(blocks_json, edges_json, column_gap, row_gap, grid) {
    let deferred7_0;
    let deferred7_1;
    try {
        const val3 = BigInt.asIntN(64, column_gap);
        const val4 = BigInt.asIntN(64, row_gap);
        const val5 = BigInt.asIntN(64, grid);
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(blocks_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(edges_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.layeredLayout(ptr0, len0, ptr1, len1, val3, val4, val5);
        var ptr6 = ret[0];
        var len6 = ret[1];
        if (ret[3]) {
            ptr6 = 0; len6 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred7_0 = ptr6;
        deferred7_1 = len6;
        return getStringFromWasm0(ptr6, len6);
    } finally {
        wasm.__wbindgen_free(deferred7_0, deferred7_1, 1);
    }
}

/**
 * Parses `json` via `GsimSchDocument::from_json` (rejects a non-v2 `schema_version` with a
 * clear message) and returns canonical re-serialized JSON.
 * @param {string} json
 * @returns {string}
 */
export function loadDocument(json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.loadDocument(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Returns a fresh, empty `Model` as JSON. Cannot fail.
 * @param {string} id
 * @param {string} name
 * @param {bigint} grid
 * @returns {string}
 */
export function newModel(id, name, grid) {
    let deferred4_0;
    let deferred4_1;
    try {
        const val3 = BigInt.asIntN(64, grid);
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.newModel(ptr0, len0, ptr1, len1, val3);
        deferred4_0 = ret[0];
        deferred4_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * `existing_json` is a JSON array of `{"x":..,"y":..,"w":..,"h":..}`; `axis` is `"horizontal"`
 * or `"vertical"`. Returns `[x, y]` as JSON.
 * @param {string} existing_json
 * @param {bigint} w
 * @param {bigint} h
 * @param {bigint} desired_x
 * @param {bigint} desired_y
 * @param {string} axis
 * @param {bigint} margin
 * @param {bigint} grid
 * @returns {string}
 */
export function placeWithoutOverlap(existing_json, w, h, desired_x, desired_y, axis, margin, grid) {
    let deferred10_0;
    let deferred10_1;
    try {
        const val3 = BigInt.asIntN(64, w);
        const val4 = BigInt.asIntN(64, h);
        const val5 = BigInt.asIntN(64, desired_x);
        const val6 = BigInt.asIntN(64, desired_y);
        const val7 = BigInt.asIntN(64, margin);
        const val8 = BigInt.asIntN(64, grid);
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(existing_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(axis, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.placeWithoutOverlap(ptr0, len0, val3, val4, val5, val6, ptr1, len1, val7, val8);
        var ptr9 = ret[0];
        var len9 = ret[1];
        if (ret[3]) {
            ptr9 = 0; len9 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred10_0 = ptr9;
        deferred10_1 = len9;
        return getStringFromWasm0(ptr9, len9);
    } finally {
        wasm.__wbindgen_free(deferred10_0, deferred10_1, 1);
    }
}

/**
 * Removes a block (and cascades wire deletion) from `model_json`. Returns updated `Model` JSON.
 * @param {string} model_json
 * @param {string} block_id
 * @returns {string}
 */
export function removeBlock(model_json, block_id) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(block_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.removeBlock(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * Wraps a `Model` JSON into `{"schema_version": 2, "model": ...}`, pretty-printed.
 * @param {string} model_json
 * @returns {string}
 */
export function saveDocument(model_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.saveDocument(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Sets a block parameter. Errors if `block_id` doesn't exist. Returns updated `Model` JSON.
 * @param {string} model_json
 * @param {string} block_id
 * @param {string} name
 * @param {string} value_json
 * @returns {string}
 */
export function setParam(model_json, block_id, name, value_json) {
    let deferred6_0;
    let deferred6_1;
    try {
        let ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3;
        try {
            ptr0 = passStringToWasm0(model_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(block_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
            ptr2 = passStringToWasm0(name, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len2 = WASM_VECTOR_LEN;
            ptr3 = passStringToWasm0(value_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len3 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr3) { wasm.__wbindgen_free(ptr3, len3 * 1, 1); }
            if (ptr2) { wasm.__wbindgen_free(ptr2, len2 * 1, 1); }
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.setParam(ptr0, len0, ptr1, len1, ptr2, len2, ptr3, len3);
        var ptr5 = ret[0];
        var len5 = ret[1];
        if (ret[3]) {
            ptr5 = 0; len5 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred6_0 = ptr5;
        deferred6_1 = len5;
        return getStringFromWasm0(ptr5, len5);
    } finally {
        wasm.__wbindgen_free(deferred6_0, deferred6_1, 1);
    }
}

/**
 * Returns a JSON array of `ValidationFailure` (`{"parameter":..., "message":...}`); an empty
 * array means every parameter with a `validate` rule passed. Only errors on malformed input
 * JSON -- validation failures themselves are reported in the returned array, never as a thrown
 * error.
 * @param {string} contract_json
 * @param {string} params_json
 * @returns {string}
 */
export function validateParameters(contract_json, params_json) {
    let deferred4_0;
    let deferred4_1;
    try {
        let ptr0, len0, ptr1, len1;
        try {
            ptr0 = passStringToWasm0(contract_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len0 = WASM_VECTOR_LEN;
            ptr1 = passStringToWasm0(params_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            len1 = WASM_VECTOR_LEN;
        } catch (e) {
            if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 1, 1); }
            if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 1, 1); }
            throw e;
        }
        const ret = wasm.validateParameters(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_787b9fb330d55d78: function(arg0, arg1) {
            const ret = new Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            table.set(0, undefined);
            table.set(1024, undefined);
            table.set(1025, null);
            table.set(1026, true);
            table.set(1027, false);
        },
    };
    return {
        __proto__: null,
        "./gsim_wasm_bg.js": import0,
    };
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(bytes) {
    numBytesDecoded += bytes.length;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true });
        cachedTextDecoder.decode();
        numBytesDecoded = bytes.length;
    }
    return cachedTextDecoder.decode(bytes);
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

let __wbg_init_promise;
async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;
    if (__wbg_init_promise === undefined) {
        __wbg_init_promise = __wbg_init_once(module_or_path);
        __wbg_init_promise.catch(() => { __wbg_init_promise = undefined; });
    }
    return __wbg_init_promise;
}

async function __wbg_init_once(module_or_path) {

    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('gsim_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
