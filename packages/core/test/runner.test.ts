import { describe, expect, it } from "vitest";

import { ProcessRunner, parseJsonOutput } from "../src/runner.js";

describe("ProcessRunner", () => {
  it("passes arguments without a shell", async () => {
    const runner = new ProcessRunner();
    const value = "$(printf should-not-run)";
    const result = await runner.run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", value], {
      cwd: process.cwd(),
    });
    expect(result.stdout).toBe(value);
  });

  it("parses command JSON", () => {
    expect(
      parseJsonOutput<{ ok: boolean }>(
        { command: "demo", args: [], cwd: "/tmp", exitCode: 0, stdout: '{"ok":true}', stderr: "" },
        "demo",
      ),
    ).toEqual({ ok: true });
  });
});
