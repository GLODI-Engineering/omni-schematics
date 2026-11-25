/**
 * Byte ranges of a `.gsim_samples` container, for a webview that cannot open
 * one.
 *
 * ## Why this is the host's half and not the whole job
 *
 * The viewer decides *which* bytes it needs and the host fetches them. That
 * split is forced, from both sides: a webview has no file system, and this
 * process has no decimator, because `vsce package --no-dependencies` ships no
 * `node_modules` and a value import of `@gensim/waveform-wasm` from here would
 * resolve on a developer's machine and throw `Cannot find module` everywhere
 * else (#175, where that is decided, and `protocol.ts`, which carries the same
 * reason for its types-only re-export).
 *
 * So there is deliberately no arithmetic in this file. It does not know where
 * a footer lives, how a stripe is laid out or which pyramid rung answers a
 * window — `crates/waveform-store` knows all of that and is the one place that
 * does. This is a positioned read with the two checks a positioned read needs:
 * the path is one this window is allowed to read, and the request cannot ask
 * for more memory than a plot could possibly want.
 *
 * `samples-index.ts` is the other direction of the same restraint: it reads a
 * container's *footer* in this process, for the signal names a manifest needs,
 * and touches no sample.
 *
 * ## The size limit, and why there is one
 *
 * `length` arrives from a webview. A webview is not an adversary here, but it
 * is a program, and a program that computes an offset wrongly asks for a
 * gigabyte as readily as for a kilobyte — `Buffer.alloc` would then take the
 * extension host down with it, taking the user's unsaved editors with it. A
 * window at a plot's point budget is tens of kilobytes whatever the file's
 * length, which is the property `--format samples` exists for, so the cap
 * below is three orders of magnitude above anything legitimate and still far
 * from fatal.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** What one request may ask for in total, across all its ranges. */
export const MAX_SAMPLES_READ_BYTES = 64 * 1024 * 1024;
/** How many ranges one request may carry. A plan coalesces; it does not fan out. */
export const MAX_SAMPLES_RANGES = 4096;
/** The only extension this reader will open. */
export const SAMPLES_EXTENSION = ".gsim_samples";

export interface SamplesRange {
  offset: number;
  length: number;
}

export interface SamplesReadLimits {
  /**
   * Directories a read is allowed inside, already resolved. The host passes
   * the open workspace folders and its own fallback run directory; a result
   * opened from elsewhere adds the directory of the document it was opened
   * from, which is the anchor its own `data.path` is relative to.
   */
  roots: string[];
  maxBytes?: number;
  maxRanges?: number;
}

export class SamplesReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SamplesReadError";
  }
}

/** `child` is `parent` itself or something inside it. */
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * The file a request names, or a refusal saying why not.
 *
 * Resolution happens here rather than being trusted from the message for the
 * reason `host.ts`'s `readSource` gives about a scripted block's path: the
 * path comes from a document, a document may have been opened from anywhere,
 * and an unchecked read is an invitation to walk out of the project with
 * `../../..`. `path.resolve` collapses those segments *before* the containment
 * check, so a `..` that escapes is caught rather than normalised into
 * something that passes.
 */
export function resolveSamplesPath(
  request: { path: string; relativeTo?: string },
  limits: SamplesReadLimits,
): string {
  const raw = request.path;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new SamplesReadError("no container was named.");
  }
  if (raw.includes("\0")) {
    throw new SamplesReadError("that path is not a path.");
  }

  const anchor = request.relativeTo ? path.dirname(fileSystemPath(request.relativeTo)) : null;
  const resolved = path.isAbsolute(raw)
    ? path.resolve(raw)
    : path.resolve(anchor ?? "", path.normalize(raw));

  if (path.extname(resolved) !== SAMPLES_EXTENSION) {
    // Narrow on purpose. This message is answered for any webview in the
    // window, so "any file the workspace contains" would be a general-purpose
    // file reader reachable from a document; the only thing it is for is a
    // sample container.
    throw new SamplesReadError(`only ${SAMPLES_EXTENSION} files are read this way.`);
  }

  // A relative path must stay under the document it was anchored to: a
  // `.gsim_sim_result` says where its samples are *beside it*, and one that
  // points somewhere else is not describing its own run.
  const roots = anchor ? [anchor, ...limits.roots] : limits.roots;
  if (!roots.some((root) => contains(path.resolve(root), resolved))) {
    throw new SamplesReadError(
      "that container is outside this window's workspace folders and the directory of " +
        "the result that names it.",
    );
  }
  return resolved;
}

/** Every range is a whole, non-negative, in-file span, and the lot fits the cap. */
export function checkRanges(
  ranges: SamplesRange[],
  size: number,
  limits: SamplesReadLimits = { roots: [] },
): void {
  const maxRanges = limits.maxRanges ?? MAX_SAMPLES_RANGES;
  const maxBytes = limits.maxBytes ?? MAX_SAMPLES_READ_BYTES;

  if (!Array.isArray(ranges)) {
    throw new SamplesReadError("the ranges are not a list.");
  }
  if (ranges.length > maxRanges) {
    throw new SamplesReadError(
      `${ranges.length} ranges in one request, and ${maxRanges} is the most this reads. ` +
        "A planned window coalesces its ranges; it does not fan out.",
    );
  }

  let total = 0;
  for (const range of ranges) {
    const { offset, length } = range ?? {};
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)) {
      throw new SamplesReadError(
        `a range of (${String(offset)}, ${String(length)}) is not a pair of whole numbers.`,
      );
    }
    if (offset < 0 || length < 0) {
      throw new SamplesReadError(`a range of (${offset}, ${length}) is negative.`);
    }
    if (offset + length > size) {
      throw new SamplesReadError(
        `a range asks for bytes ${offset}..${offset + length} of a ${size}-byte container.`,
      );
    }
    total += length;
    if (total > maxBytes) {
      // Checked inside the loop, not after it: the point is never to allocate
      // the thing, so the sum must fail before any buffer is asked for.
      throw new SamplesReadError(
        `${total} bytes in one request, and ${maxBytes} is the most this reads at once. ` +
          "A window at a plot's point budget is tens of kilobytes whatever the run's length.",
      );
    }
  }
}

/**
 * Read `ranges` of the container `request` names.
 *
 * One open file handle for the whole request: a planned window is a handful of
 * neighbouring spans, and reopening the file per span would pay a syscall for
 * each one to read the same page.
 *
 * `ranges: []` is a legal request and returns the size alone, which is what a
 * reader needs first and the one number it cannot work out for itself.
 */
export function readSamplesRanges(
  request: { path: string; relativeTo?: string; ranges: SamplesRange[] },
  limits: SamplesReadLimits,
): { size: number; chunks: { offset: number; bytes: Buffer }[] } {
  const file = resolveSamplesPath(request, limits);

  let handle: number;
  try {
    handle = fs.openSync(file, "r");
  } catch (error) {
    throw new SamplesReadError(
      `could not open ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    const size = fs.fstatSync(handle).size;
    checkRanges(request.ranges ?? [], size, limits);

    const chunks: { offset: number; bytes: Buffer }[] = [];
    for (const { offset, length } of request.ranges ?? []) {
      const bytes = Buffer.alloc(length);
      // A short read is reported rather than padded with zeros: zeros in a
      // sample file draw a flat line, which looks like a simulation result.
      const read = length === 0 ? 0 : fs.readSync(handle, bytes, 0, length, offset);
      if (read !== length) {
        throw new SamplesReadError(
          `read ${read} of ${length} bytes at ${offset}; the file changed under the reader.`,
        );
      }
      chunks.push({ offset, bytes });
    }
    return { size, chunks };
  } finally {
    fs.closeSync(handle);
  }
}

/**
 * The on-disk path of a `file:` URI string.
 *
 * Written here rather than taken from `vscode.Uri` so this module stays
 * importable by a unit test with no extension host: everything else in it is
 * `node:fs` and `node:path`, and `host.ts` is where `vscode` belongs.
 */
export function fileSystemPath(uri: string): string {
  if (!uri.startsWith("file:")) {
    // Not a file URI — a webview may be editing an untitled or virtual
    // document. Treated as a path so the containment check below still has
    // something to reject, rather than throwing a URL parse error here.
    return uri;
  }
  const url = new URL(uri);
  const decoded = decodeURIComponent(url.pathname);
  // `file:///C:/x` decodes to `/C:/x`, which `path.resolve` would read as a
  // directory called `C:` at the root of the current drive.
  return /^\/[A-Za-z]:/.test(decoded) ? decoded.slice(1) : decoded;
}
