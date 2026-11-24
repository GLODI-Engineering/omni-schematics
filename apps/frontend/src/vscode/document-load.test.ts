/**
 * #146 — a document the editor cannot read must not be destroyed by it.
 *
 * The reported symptom was cosmetic-sounding: a schematic opened on an empty canvas
 * with a toast reading "Nothing to simulate — the schematic is empty. Add a component
 * first." Both halves were accurate about the store and wrong about the situation. The
 * document had failed `deserialize`, the failure went to `gsim/log` — appended to the
 * kernel's lifecycle channel, closed by default — and the store still held the empty
 * default model.
 *
 * The dangerous part is the advice. Adding a component to that canvas marks the editor
 * dirty with the empty model plus one block, and saving replaces the user's schematic
 * with it. So the fix is not only "say something": it is that nothing leaves the webview
 * while a document is unreadable.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const postToHost = vi.fn();
vi.mock("../ipc/vscode-host", () => ({
  postToHost: (message: unknown) => postToHost(message),
  getWebviewInit: () => undefined,
  onHostMessage: () => () => {},
}));

import {
  currentDocumentText,
  loadDocumentTextOrReport,
  resetDocumentLoadState,
  unreadableDocument,
} from "./document-load";

/** A document that fails the schema the way every committed example used to. */
const NO_NET = JSON.stringify({
  schema_version: 2,
  model: {
    id: "m",
    name: "m",
    grid: 10,
    params: [],
    blocks: [],
    wires: [
      {
        id: "w1",
        from: { block: "a", port: "p" },
        to: { block: "b", port: "n" },
        kind: "physical-electrical",
        waypoints: [],
        pinned: false,
      },
    ],
    lines: [],
    nets: [],
    simulation: {},
    metadata: {},
  },
});

const NOT_JSON = "{ this is not a schematic";

beforeEach(() => {
  postToHost.mockClear();
  resetDocumentLoadState();
});

describe("a document that cannot be read", () => {
  it("is recorded rather than swallowed", () => {
    loadDocumentTextOrReport(NO_NET);
    const failure = unreadableDocument();
    expect(failure).not.toBeNull();
    expect(failure?.reason).toContain("net");
  });

  it("is handed back to the host byte for byte, not re-serialised", () => {
    // The assertion that matters. Serialising the store here would give the host an
    // empty model to write over the file.
    loadDocumentTextOrReport(NO_NET);
    expect(currentDocumentText()).toBe(NO_NET);
  });

  it("tells the host in a way that surfaces, not only in the log", () => {
    loadDocumentTextOrReport(NO_NET);
    const types = postToHost.mock.calls.map(([message]) => (message as { type: string }).type);
    // Both: the log entry is for whoever debugs it, the other is for the user.
    expect(types).toContain("gsim/log");
    expect(types).toContain("gsim/documentUnreadable");
  });

  it("shows a banner that names the problem and promises the file is intact", () => {
    loadDocumentTextOrReport(NO_NET);
    const banner = document.getElementById("gsim-unreadable-banner");
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("could not be read");
    // The sentence that answers the question the old toast provoked.
    expect(banner?.textContent).toContain("has not been changed");
  });

  it("does not stack banners when a second document also fails", () => {
    loadDocumentTextOrReport(NO_NET);
    loadDocumentTextOrReport(NOT_JSON);
    expect(document.querySelectorAll("#gsim-unreadable-banner")).toHaveLength(1);
  });

  it("covers malformed JSON too, not just schema failures", () => {
    loadDocumentTextOrReport(NOT_JSON);
    expect(unreadableDocument()).not.toBeNull();
    expect(currentDocumentText()).toBe(NOT_JSON);
  });
});

describe("a document that reads correctly", () => {
  const GOOD = JSON.stringify({
    schema_version: 2,
    model: {
      id: "m",
      name: "m",
      grid: 10,
      params: [],
      blocks: [],
      wires: [],
      lines: [],
      nets: [],
      simulation: {},
      metadata: {},
    },
  });

  it("records no failure and reports nothing to the host", () => {
    loadDocumentTextOrReport(GOOD);
    expect(unreadableDocument()).toBeNull();
    const types = postToHost.mock.calls.map(([message]) => (message as { type: string }).type);
    expect(types).not.toContain("gsim/documentUnreadable");
    expect(document.getElementById("gsim-unreadable-banner")).toBeNull();
  });

  it("clears a previous failure, so one bad file does not freeze the editor", () => {
    // Opening a broken document and then a good one in the same webview must leave
    // the good one editable; otherwise the guard becomes its own bug.
    loadDocumentTextOrReport(NO_NET);
    expect(unreadableDocument()).not.toBeNull();
    loadDocumentTextOrReport(GOOD);
    expect(unreadableDocument()).toBeNull();
    expect(document.getElementById("gsim-unreadable-banner")).toBeNull();
    expect(currentDocumentText()).not.toBe(NO_NET);
  });
});
