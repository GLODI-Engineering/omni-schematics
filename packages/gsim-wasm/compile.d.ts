import type * as engine from "./pkg/gsim_wasm.js";

export declare const SCHEMA_VERSION: 2;
export declare const DEFAULT_TARGET: "general-simulator";

/** The initialised engine module namespace, as both loaders hand it back. */
export type Engine = typeof engine;

/** Which drawn block each netlist name came from — the engine's own shape. */
export interface CompileProvenance {
  elements?: unknown[];
  nets?: unknown[];
}

export interface CompileResult {
  netlist: string;
  notes: string[];
  provenance: CompileProvenance | null;
}

export declare function asDocumentText(input: string | object): string;

export declare function compileDocument(
  engine: Engine,
  input: string | object,
  target?: string,
): CompileResult;
