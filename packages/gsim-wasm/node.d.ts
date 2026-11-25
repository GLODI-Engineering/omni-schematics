import type { Engine } from "./compile.js";

export declare function loadEngine(): Promise<Engine>;
export { compileDocument, asDocumentText, DEFAULT_TARGET, SCHEMA_VERSION } from "./compile.js";
export type { CompileResult, CompileProvenance, Engine } from "./compile.js";
