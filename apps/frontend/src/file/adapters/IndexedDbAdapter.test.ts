/**
 * What the storage adapter writes, which is what #118 turned out to be about.
 *
 * The e2e spec that caught it (`tests/e2e/persistence.spec.ts`) asserts a
 * save → reload → open round trip is byte-identical, and it was not: the model
 * came back renamed "<name> Copy" under a `-copy-<timestamp>` id. The blame
 * looked like it was on `openFileById`, but opening is faithful — `saveAs` was
 * rewriting the document on the way in, and `saveFile()` routes the first save
 * of a never-saved model through `saveAs` because there is no ref yet. These
 * tests pin the adapter's half down at the unit level, so the next regression
 * does not need a 16-minute browser suite to be noticed.
 */

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it } from "vitest";

import type { ModelDocument } from "../../model/types";
import { serialize } from "../serializer";
import { IndexedDbAdapter } from "./IndexedDbAdapter";

function makeDocument(id: string, name: string): ModelDocument {
  return {
    schema_version: 2,
    model: {
      id,
      name,
      grid: 10,
      params: [],
      blocks: [],
      wires: [],
      lines: [],
      nets: [],
      simulation: {},
      metadata: {},
    },
  };
}

// One adapter for the file, emptied between tests through its own API.
// `indexedDB.deleteDatabase` would be the obvious reset and it deadlocks here:
// the adapter caches its connection and never closes it, so the delete goes to
// `onblocked` and every later open waits on it.
const adapter = new IndexedDbAdapter();

beforeEach(async () => {
  for (const entry of await adapter.list()) {
    await adapter.delete(entry.id);
  }
});

describe("#118: IndexedDbAdapter.saveAs stores the model, it does not duplicate it", () => {
  it("keeps the model's own name and id — the first Ctrl+S is not a 'Save a copy'", async () => {
    const document = makeDocument("model-1", "my-model");

    const ref = await adapter.saveAs(document);
    const loaded = await adapter.load(ref);

    expect(loaded.model.name).toBe("my-model");
    expect(loaded.model.id).toBe("model-1");
  });

  it("round-trips byte-identically, which is what persistence.spec.ts asserts", async () => {
    const document = makeDocument("model-1", "e2e-persist-1");

    const ref = await adapter.saveAs(document);

    // Through `serialize`, because that is the comparison the e2e spec makes:
    // it reads `__gensim_serialize()` either side of the reload, and the
    // serialiser canonicalises key order. Comparing raw `JSON.stringify` here
    // would fail on field order alone and say nothing about the round trip.
    expect(serialize(await adapter.load(ref))).toBe(serialize(document));
  });

  it("uses the model's id as its ref, so a later Save writes back to the same record", async () => {
    const ref = await adapter.saveAs(makeDocument("model-1", "my-model"));

    expect(ref).toBe("model-1");
    // The point of the ref: `saveFile()` holds it and saves through `save()`
    // from then on, so the second save must not create a second entry.
    await adapter.save(ref, makeDocument("model-1", "my-model renamed"));
    const entries = await adapter.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("my-model renamed");
  });

  it("does not clobber the original when the model is already stored", async () => {
    const first = await adapter.saveAs(makeDocument("model-1", "my-model"));

    const second = await adapter.saveAs(makeDocument("model-1", "my-model"));

    expect(second).not.toBe(first);
    expect(await adapter.list()).toHaveLength(2);
    // Both records still hold the document they were given — a fresh key is
    // what "Save As" needs, not a rewritten document.
    expect((await adapter.load(first)).model.name).toBe("my-model");
    expect((await adapter.load(second)).model.name).toBe("my-model");
  });

  it("lists a saved model under the name the user gave it", async () => {
    await adapter.saveAs(makeDocument("model-1", "my-model"));

    const entries = await adapter.list();
    expect(entries.map((entry) => entry.name)).toEqual(["my-model"]);
  });
});
