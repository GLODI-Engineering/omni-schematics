import * as path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // `kernel.ts` imports `vscode`, which only exists inside a running
      // editor. Without this alias the file cannot be imported by vitest at
      // all, which is why its process-lifecycle logic had no unit test and
      // #130 (three `return null` paths that never notified the webview)
      // went unnoticed. Integration specs under src/integration/ run against
      // the real API and are excluded below.
      vscode: path.resolve(__dirname, "src/test-support/vscode-stub.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration specs run inside a real VS Code, not vitest.
    exclude: ["src/integration/**"],
  },
});
