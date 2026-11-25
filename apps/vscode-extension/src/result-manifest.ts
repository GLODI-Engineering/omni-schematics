/**
 * The `.gsim_sim_result` document that points at a `.gsim_samples` file.
 *
 * ## Why the samples are not in it
 *
 * The format has two storage modes and the manifest says which. `inline`
 * carries every vector's samples as base64 inside the JSON, which is right up
 * to a few million of them and keeps the file self-contained -- committable,
 * attachable to a review. It is hopeless beyond that: a multi-gigabyte run
 * would have to be parsed in full before the first pixel.
 *
 * `samples` names a sibling file instead, and that is what a solver run
 * produces. The document stays a few hundred bytes whatever the run's length,
 * and the viewer reads windows out of the container next to it.
 *
 * ## Who is the authority on what
 *
 * The container holds the samples and the column names the netlist gave them.
 * It does not hold units: a netlist has none, so the solver has none to write.
 * Units, quantities and the sweep's domain live here, which is why
 * `SamplesSource::with_manifest` on the reading side takes them from this
 * document and takes nothing else from it.
 */

import * as path from "node:path";

export interface ManifestVector {
  name: string;
  /** May be empty. A netlist has no units, so "" is honest, not missing. */
  unit: string;
  quantity?: string;
}

export interface ManifestRequest {
  /** Stable identifier for this run, used as the result's own id. */
  runId: string;
  analysis: string;
  /** The schematic this came from, for the reader to show. */
  source?: string;
  /** Absolute path of the `.gsim_samples` file the solver wrote. */
  samplesPath: string;
  /** Absolute path the manifest itself will be written to. */
  manifestPath: string;
  sweep: ManifestVector & { domain?: string };
  signals: ManifestVector[];
  /** Defaults to now; injectable so a test can assert the whole document. */
  created?: string;
}

export interface GsimSimResultManifest {
  schema_version: 2;
  run: { id: string; analysis: string; source?: string; created: string };
  data: { kind: "samples"; path: string; pyramid: true };
  sweep: Record<string, unknown>;
  signals: Record<string, unknown>[];
}

/**
 * Builds the document. Does not write it: the caller owns the file system, and
 * a pure function is what the tests can hold still.
 *
 * `data.path` is made relative to the manifest's own directory, which is the
 * schema's rule and the reason a result directory can be moved or copied
 * whole without rewriting anything inside it.
 */
export function buildManifest(request: ManifestRequest): GsimSimResultManifest {
  const relative = path
    .relative(path.dirname(request.manifestPath), request.samplesPath)
    // The schema's paths are POSIX-style so a result written on Windows still
    // opens elsewhere. `path.relative` yields backslashes there.
    .split(path.sep)
    .join("/");

  const vector = (v: ManifestVector & { domain?: string }) => {
    const out: Record<string, unknown> = { name: v.name, unit: v.unit };
    if (v.quantity) {
      out.quantity = v.quantity;
    }
    if (v.domain) {
      out.domain = v.domain;
    }
    return out;
  };

  const run: GsimSimResultManifest["run"] = {
    id: request.runId,
    analysis: request.analysis,
    created: request.created ?? new Date().toISOString(),
  };
  if (request.source) {
    run.source = request.source;
  }

  return {
    schema_version: 2,
    run,
    // `pyramid` is always true for this mode: the levels are part of the
    // container's layout rather than something a writer may skip.
    data: { kind: "samples", path: relative, pyramid: true },
    sweep: vector(request.sweep),
    signals: request.signals.map(vector),
  };
}

/** The document as the bytes to write, newline-terminated like the editor's. */
export function serializeManifest(manifest: GsimSimResultManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
