/**
 * The bundled example schematics.
 *
 * A fresh install had nothing to open: `unzip -l` on the 0.6.0 `.vsix` matched
 * no `.gsim_sch` at all, so the first thing a new user could do with the editor
 * was draw a circuit from nothing. `scripts/bundle-examples.mjs` copies the
 * documents into `media/examples`, and this offers them.
 *
 * An example is opened as an **untitled copy**, not from the extension's own
 * directory. Opening the shipped file directly would let a user edit the
 * installation -- and lose their work on the next update, which replaces it.
 */
import { tmpdir } from "node:os";

import * as vscode from "vscode";

/** Human-readable titles, by file name without its extension. */
const TITLES: Record<string, string> = {
  buck_converter: "Buck converter — 48 V to 19 V, switch and LC filter",
  boost_converter: "Boost converter — 12 V to 24 V, inductor on the input",
  pfc_boost: "PFC boost front end — 230 V mains, bridge rectifier, 400 V bus",
  llc_converter: "LLC resonant converter — half bridge, resonant tank, transformer",
  psfb_converter: "Phase-shifted full bridge — 400 V to 48 V, four switches",
};

export interface ExampleDocument {
  readonly name: string;
  readonly label: string;
  readonly uri: vscode.Uri;
}

/** Every example in the installed extension, in a stable order. */
export async function listExamples(extensionUri: vscode.Uri): Promise<ExampleDocument[]> {
  const dir = vscode.Uri.joinPath(extensionUri, "media", "examples");
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    // A development checkout that has not run `pnpm bundle:examples` has no
    // such directory. An empty list is the honest answer; the caller says so.
    return [];
  }
  return entries
    .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".gsim_sch"))
    .map(([name]) => {
      const stem = name.replace(/\.gsim_sch$/, "");
      return {
        name: stem,
        label: TITLES[stem] ?? stem.replace(/_/g, " "),
        uri: vscode.Uri.joinPath(dir, name),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Ask which example to open, then open a copy of it.
 *
 * The copy is written into the workspace when there is one, so that Run has a
 * document on disk and the user can keep it. With no folder open it goes to a
 * temporary file instead of failing: the point of an example is to be opened
 * immediately, and refusing until a folder exists would be a poor welcome.
 */
export async function openExample(extensionUri: vscode.Uri): Promise<void> {
  const examples = await listExamples(extensionUri);
  if (examples.length === 0) {
    void vscode.window.showErrorMessage(
      "No examples are bundled with this build. In a checkout, run `pnpm bundle:examples`.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    examples.map((example) => ({ label: example.label, example })),
    { title: "Open an example schematic", placeHolder: "Pick a converter to open" },
  );
  if (!picked) {
    return;
  }

  const bytes = await vscode.workspace.fs.readFile(picked.example.uri);
  const folder = vscode.workspace.workspaceFolders?.[0];
  const target = folder
    ? vscode.Uri.joinPath(folder.uri, `${picked.example.name}.gsim_sch`)
    : vscode.Uri.joinPath(vscode.Uri.file(tmpdir()), `${picked.example.name}.gsim_sch`);

  // Never silently replace a file the user already has. An example they have
  // edited is their work, and this command is not a reason to lose it.
  let destination = target;
  let suffix = 1;
  while (await exists(destination)) {
    destination = target.with({ path: target.path.replace(/\.gsim_sch$/, `-${suffix}.gsim_sch`) });
    suffix += 1;
  }

  await vscode.workspace.fs.writeFile(destination, bytes);
  await vscode.commands.executeCommand("vscode.openWith", destination, "omniSchematics.schematic");
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
