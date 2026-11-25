/**
 * What "New Schematic" puts on disk.
 *
 * The command used to write a zero-byte file. On the open path that is
 * harmless — `apps/frontend/src/vscode/schematic-main.tsx` checks for empty
 * text and starts the editor from its default model — but the revert path has
 * no such check: `schematicEditor.revertCustomDocument` posts the file's bytes
 * as `gsim/setDocument`, which reaches `loadDocumentTextOrReport`, which hands
 * `""` to `JSON.parse`. That throws, the editor raises its "could not be read"
 * banner and records the document as unreadable — and while that is recorded,
 * `currentDocumentText()` returns the original bytes, so **every later save is
 * a silent no-op**.
 *
 * In plain terms: create a new schematic, press File ▸ Revert, and the editor
 * stops saving your work without saying so. Writing a real document instead of
 * nothing removes the cause; `vscode/document-load.ts` also stops treating an
 * empty file as a parse failure, which covers the ones a user made with
 * `touch` (#211).
 *
 * The shape is `gsim_sch.schema.json`'s: `schema_version` 2 and a `model` with
 * all ten required members. `new-schematic.test.ts` reads that schema and
 * holds this to it, so a field added there fails here rather than at the
 * moment a user opens the file they just created.
 */

/** The name offered in the Save dialog when nothing better is known. */
export const NEW_SCHEMATIC_BASENAME = "untitled.gsim_sch";

/** The extension a schematic must carry for the custom editor to claim it. */
export const SCHEMATIC_EXTENSION = ".gsim_sch";

function identifier(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "model" : `model-${slug}`;
}

/**
 * A minimal, valid, empty schematic, as text.
 *
 * Pretty-printed with a trailing newline: this is the first file a new user
 * will ever open in a text editor, and the editor's own writer emitting one
 * long line is a known wart being tracked separately (#201), not a format
 * requirement.
 */
export function newSchematicDocument(name: string): string {
  const document = {
    schema_version: 2,
    model: {
      id: identifier(name),
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
  return `${JSON.stringify(document, null, 2)}\n`;
}

/** The model name to give a file, from its own basename. */
export function modelNameFor(fileName: string): string {
  const base = fileName.replace(/\\/g, "/").split("/").pop() ?? fileName;
  const stem = base.endsWith(SCHEMATIC_EXTENSION)
    ? base.slice(0, -SCHEMATIC_EXTENSION.length)
    : base;
  return stem.trim() === "" ? "Untitled model" : stem;
}
