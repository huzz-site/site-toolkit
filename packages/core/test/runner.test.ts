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

  it("can remove an inherited environment variable for a child command", async () => {
    const runner = new ProcessRunner();
    const key = "SITE_TOOLKIT_TEST_ACCOUNT";
    const previous = process.env[key];
    process.env[key] = "wrong-account";
    try {
      const result = await runner.run(
        process.execPath,
        ["-e", `process.stdout.write(process.env.${key} ?? "")`],
        { cwd: process.cwd(), env: { [key]: undefined } },
      );
      expect(result.stdout).toBe("");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
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
