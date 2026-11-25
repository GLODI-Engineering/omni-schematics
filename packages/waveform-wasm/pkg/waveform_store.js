/* @ts-self-types="./waveform_store.d.ts" */

/**
 * Bytes the host fetched, on their way back in.
 *
 * A handle rather than one big argument because the ranges arrive one reply
 * at a time: the viewer plans, the host answers each range, and each answer
 * is put here as it lands. Passing them as a single concatenated buffer would
 * mean the caller rebuilding the offsets this already knows.
 */
export class FetchedRanges {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        FetchedRangesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_fetchedranges_free(ptr, 0);
    }
    /**
     * Bytes held — what the last read actually cost to fetch.
     * @returns {number}
     */
    bytesHeld() {
        const ret = wasm.fetchedranges_bytesHeld(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} size
     */
    constructor(size) {
        const ret = wasm.fetchedranges_new(size);
        this.__wbg_ptr = ret;
        FetchedRangesFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * One fetched range. `offset` is a file offset; a `f64` carries any
     * integer below 2^53, which is nine petabytes.
     * @param {number} offset
     * @param {Uint8Array | number[]} bytes
     */
    put(offset, bytes) {
        const val2 = +offset;
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.fetchedranges_put(this.__wbg_ptr, val2, ptr0, len0);
    }
}
if (Symbol.dispose) FetchedRanges.prototype[Symbol.dispose] = FetchedRanges.prototype.free;

/**
 * A `.gsim_samples` file, read through ranges somebody else fetches.
 *
 * The viewer cannot read a file and the host cannot decimate (#175), so this
 * is the half that knows *which bytes are needed*. The sequence is:
 *
 * 1. [`SamplesFile::tailSpan`], then [`SamplesFile::footerSpan`], then
 *    [`SamplesFile::prologueSpans`] — three small reads whose locations are
 *    arithmetic, fetched by the host.
 * 2. `new SamplesFile(size, prologue)`, which opens the file and fails here
 *    if it is truncated or not one.
 * 3. [`SamplesFile::plan`] for a window, then the host fetches those ranges,
 *    then [`SamplesFile::slice`] returns the points.
 *
 * Every offset in that sequence is computed here. The caller fetches and
 * does no arithmetic, which is the point: there is one implementation of the
 * layout and it is the one the writer agrees with.
 */
export class SamplesFile {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SamplesFileFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_samplesfile_free(ptr, 0);
    }
    /**
     * `[from, to]`, taken from the stripe directory rather than any sample.
     * Empty when the file holds no stripes.
     * @returns {Float64Array}
     */
    extent() {
        const ret = wasm.samplesfile_extent(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Where the footer is, from those sixteen bytes. Errors on a missing
     * trailing magic, which means the run never finished writing.
     * @param {number} size
     * @param {Uint8Array | number[]} tail
     * @returns {Float64Array}
     */
    static footerSpan(size, tail) {
        const val2 = +size;
        const ptr0 = passArray8ToWasm0(tail, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.samplesfile_footerSpan(val2, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} size
     * @param {FetchedRanges} prologue
     */
    constructor(size, prologue) {
        _assertClass(prologue, FetchedRanges);
        const ret = wasm.samplesfile_new(size, prologue.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        SamplesFileFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The ranges a window would read, as `[offset, len, …]`, coalesced.
     *
     * A recording pass: the answer depends on the stripe geometry, the
     * directory and the rung, all of which are in the prologue already — no
     * sample value takes part, which is why the second pass asks for exactly
     * these.
     * @param {string[]} names
     * @param {number | null | undefined} from
     * @param {number | null | undefined} to
     * @param {number} max_points
     * @returns {Float64Array}
     */
    plan(names, from, to, max_points) {
        const val2 = +(isLikeNone(from) ? 0 : from);
        const val3 = +(isLikeNone(to) ? 0 : to);
        const val4 = +max_points;
        const ptr0 = passArrayJsValueToWasm0(names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.samplesfile_plan(this.__wbg_ptr, ptr0, len0, !isLikeNone(from), val2, !isLikeNone(to), val3, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The header, stripe directory and summary, from the footer's JSON.
     * @param {string} footer_json
     * @returns {Float64Array}
     */
    static prologueSpans(footer_json) {
        const ptr0 = passStringToWasm0(footer_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.samplesfile_prologueSpans(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Samples per signal in the run — not the number of points a read returns.
     * @returns {number}
     */
    rows() {
        const ret = wasm.samplesfile_rows(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * The signals this file holds, as JSON: `[{name, unit, quantity, analysis}]`.
     * @returns {string}
     */
    signalsJson() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.samplesfile_signalsJson(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The window, from ranges a [`SamplesFile::plan`] asked for.
     *
     * Flat: `[sweep…, signal0…, …]`, for the reason the inline store's slice
     * is flat — the caller knows how many signals it asked for and can
     * subarray one buffer at no cost.
     * @param {string[]} names
     * @param {number | null | undefined} from
     * @param {number | null | undefined} to
     * @param {number} max_points
     * @param {FetchedRanges} fetched
     * @returns {Float64Array}
     */
    slice(names, from, to, max_points, fetched) {
        _assertClass(fetched, FetchedRanges);
        const val2 = +(isLikeNone(from) ? 0 : from);
        const val3 = +(isLikeNone(to) ? 0 : to);
        const val4 = +max_points;
        const ptr0 = passArrayJsValueToWasm0(names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.samplesfile_slice(this.__wbg_ptr, ptr0, len0, !isLikeNone(from), val2, !isLikeNone(to), val3, val4, fetched.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * The last sixteen bytes: a footer offset and the trailing magic.
     * @param {number} size
     * @returns {Float64Array}
     */
    static tailSpan(size) {
        const ret = wasm.samplesfile_tailSpan(size);
        return ret;
    }
}
if (Symbol.dispose) SamplesFile.prototype[Symbol.dispose] = SamplesFile.prototype.free;

export class WaveformStore {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WaveformStoreFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_waveformstore_free(ptr, 0);
    }
    /**
     * Read a `.gsim_sim_result` whose samples are inline.
     * @param {string} manifest_json
     */
    constructor(manifest_json) {
        const ptr0 = passStringToWasm0(manifest_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformstore_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        WaveformStoreFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The signals this result holds, as JSON: `[{name, unit, quantity, analysis}]`.
     *
     * JSON rather than a typed array of objects because it is read once per
     * opened file, where a typed boundary would cost more in generated glue
     * than it saves.
     * @returns {string}
     */
    signalsJson() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformstore_signalsJson(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * `[sweep…, signal0…, …]` for `names` over `[from, to]`, at most
     * `max_points` samples each.
     *
     * Pass `from`/`to` as `undefined` for the whole extent.
     * @param {string[]} names
     * @param {number | null | undefined} from
     * @param {number | null | undefined} to
     * @param {number} max_points
     * @returns {Float64Array}
     */
    slice(names, from, to, max_points) {
        const val2 = +(isLikeNone(from) ? 0 : from);
        const val3 = +(isLikeNone(to) ? 0 : to);
        const val4 = +max_points;
        const ptr0 = passArrayJsValueToWasm0(names, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.waveformstore_slice(this.__wbg_ptr, ptr0, len0, !isLikeNone(from), val2, !isLikeNone(to), val3, val4);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @returns {string}
     */
    sweepDomain() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.waveformstore_sweepDomain(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) WaveformStore.prototype[Symbol.dispose] = WaveformStore.prototype.free;

/**
 * Reduce samples already in the page to a point budget, peak-preserving.
 *
 * ## Why this is here as well as [`SamplesFile::slice`]
 *
 * A container is not the only way samples reach the viewer. A
 * `kind: "inline"` result carries them in the document, a capture replayed
 * from a file is read by the editor, and a previous run kept for an overlay
 * is already in memory. All of those still have to be reduced to what a plot
 * can show, and before this they were reduced by a hand-maintained
 * TypeScript copy of [`crate::decimate::minmax_envelope`] whose own comment
 * said so (#157). One algorithm means one of them, and the one that survives
 * is the one the writer and the server already agree with.
 *
 * Flat in and flat out, for the reason a slice is flat: `columns` is
 * `column_count` runs of `time.len()` values laid end to end, and the result
 * is `[time…, column0…, column1…, …]` over however many points the budget
 * left. The caller knows both counts, so it can subarray one buffer at no
 * cost instead of paying for an object per column at the boundary.
 * @param {Float64Array | number[]} time
 * @param {Float64Array | number[]} columns
 * @param {number} column_count
 * @param {number} max_points
 * @returns {Float64Array}
 */
export function minmaxEnvelope(time, columns, column_count, max_points) {
    const val3 = +column_count;
    const val4 = +max_points;
    let ptr0, len0, ptr1, len1;
    try {
        ptr0 = passArrayF64ToWasm0(time, wasm.__wbindgen_malloc);
        len0 = WASM_VECTOR_LEN;
        ptr1 = passArrayF64ToWasm0(columns, wasm.__wbindgen_malloc);
        len1 = WASM_VECTOR_LEN;
    } catch (e) {
        if (ptr1) { wasm.__wbindgen_free(ptr1, len1 * 8, 8); }
        if (ptr0) { wasm.__wbindgen_free(ptr0, len0 * 8, 8); }
        throw e;
    }
    const ret = wasm.minmaxEnvelope(ptr0, len0, ptr1, len1, val3, val4);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_208446807d0d1e30: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_string_get_7ce8eee7fd327545: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 1, len1, true);
            getDataViewMemory0().setInt32((arg0 >>> 0) + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_4c88d8bf264fd984: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_new_from_slice_aaf85a9746711968: function(arg0, arg1) {
            const ret = new Float64Array(getArrayF64FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_07edd8a7019b8c30: function(arg0) {
            const ret = new Float64Array(arg0 >>> 0);
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
        "./waveform_store_bg.js": import0,
    };
}

const FetchedRangesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_fetchedranges_free(ptr, 1));
const SamplesFileFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_samplesfile_free(ptr, 1));
const WaveformStoreFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_waveformstore_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
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

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
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
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
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
        module_or_path = new URL('waveform_store_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
