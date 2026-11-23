/**
 * The slice of the `vscode` module that `kernel.ts` touches, so it can be unit
 * tested at all.
 *
 * Why this exists: `kernel-core.ts` is the pure half, and it is well covered.
 * `kernel.ts` — the half that owns the child process and decides whether to
 * tell the webview anything — imports `vscode` and so had no unit test of any
 * kind. That is precisely where #130 lived: three `return null` paths that
 * never fired `onDidChange`, which no test could have caught because no test
 * could import the file.
 *
 * `vitest.config.ts` aliases `vscode` here. Only the members `kernel.ts`
 * actually uses are implemented; anything else is deliberately absent so a new
 * dependency on the real API fails loudly rather than silently doing nothing.
 */

export class Disposable {
  constructor(private readonly onDispose: () => void) {}
  dispose(): void {
    this.onDispose();
  }
}

/** Mirrors `vscode.EventEmitter`'s listener semantics closely enough to test with. */
export class EventEmitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };

  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export interface OutputChannel {
  append(value: string): void;
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

/** Collects what was written, so a test can assert the reason was logged. */
export function createRecordingChannel(): OutputChannel & { readonly lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    append: (value: string) => lines.push(value),
    appendLine: (value: string) => lines.push(value),
    show: () => {},
    dispose: () => {},
  };
}

// --- mutable test state -----------------------------------------------------

type ConfigValues = Record<string, unknown>;

const state: {
  config: ConfigValues;
  workspaceFolders: { uri: { fsPath: string } }[] | undefined;
  errorMessages: string[];
} = { config: {}, workspaceFolders: undefined, errorMessages: [] };

/** Reset between tests, and set the settings/folders a test wants. */
export function __setTestState(next: {
  config?: ConfigValues;
  workspaceFolders?: { uri: { fsPath: string } }[];
}): void {
  state.config = next.config ?? {};
  state.workspaceFolders = next.workspaceFolders;
  state.errorMessages = [];
}

/** Every `showErrorMessage` string shown since the last `__setTestState`. */
export function __shownErrors(): readonly string[] {
  return state.errorMessages;
}

export const workspace = {
  getConfiguration(_section: string) {
    return {
      get<T>(key: string): T | undefined {
        return state.config[key] as T | undefined;
      },
    };
  },
  get workspaceFolders() {
    return state.workspaceFolders;
  },
};

export const window = {
  showErrorMessage(message: string, ..._items: string[]): Promise<string | undefined> {
    state.errorMessages.push(message);
    return Promise.resolve(undefined);
  },
  createOutputChannel(_name: string): OutputChannel {
    return createRecordingChannel();
  },
};
