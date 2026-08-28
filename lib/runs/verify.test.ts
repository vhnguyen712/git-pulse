import { describe, it, expect } from "vitest";
import { pickVerifyCommands, summarizeVerify, runVerification, type CommandRunner } from "./verify";

describe("pickVerifyCommands", () => {
  it("selects known scripts in a stable order", () => {
    const scripts = { build: "next build", test: "vitest run", lint: "eslint", dev: "next dev" };
    expect(pickVerifyCommands(scripts)).toEqual(["npm run lint", "npm run test", "npm run build"]);
  });
  it("ignores non-string and absent scripts", () => {
    expect(pickVerifyCommands({ test: 123 as unknown as string })).toEqual([]);
    expect(pickVerifyCommands(undefined)).toEqual([]);
    expect(pickVerifyCommands(null)).toEqual([]);
  });
});

describe("summarizeVerify", () => {
  it("passes only when every command passed and at least one ran", () => {
    expect(summarizeVerify([]).skipped).toBe(true);
    expect(summarizeVerify([]).passed).toBe(false);
    expect(
      summarizeVerify([{ command: "a", exitCode: 0, passed: true, outputTail: "" }]).passed,
    ).toBe(true);
    expect(
      summarizeVerify([
        { command: "a", exitCode: 0, passed: true, outputTail: "" },
        { command: "b", exitCode: 1, passed: false, outputTail: "" },
      ]).passed,
    ).toBe(false);
  });
});

describe("runVerification", () => {
  it("runs all commands when they pass", async () => {
    const run: CommandRunner = async (command) => ({ exitCode: 0, output: `${command} ok` });
    const result = await runVerification("/wt", ["npm run lint", "npm run test"], { run });
    expect(result.passed).toBe(true);
    expect(result.results.map((r) => r.command)).toEqual(["npm run lint", "npm run test"]);
  });

  it("stops at the first failing command", async () => {
    const run: CommandRunner = async (command) =>
      command.includes("lint") ? { exitCode: 2, output: "lint failed" } : { exitCode: 0, output: "ok" };
    const result = await runVerification("/wt", ["npm run lint", "npm run test"], { run });
    expect(result.passed).toBe(false);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ command: "npm run lint", exitCode: 2, passed: false });
  });

  it("treats an empty command list as skipped", async () => {
    const result = await runVerification("/wt", []);
    expect(result).toEqual({ passed: false, skipped: true, results: [] });
  });
});
