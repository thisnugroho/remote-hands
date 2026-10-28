import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatCommandResult, OUTPUT_LIMIT, truncateOutput } from "../output.ts";
import { ASKPASS_SCRIPT, prepareRuntime, readServers, runProcess, writeServers } from "../runtime.ts";
import { parseServersFile } from "../servers.ts";

function temporary(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "bb-ssh-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

const signal = () => new AbortController().signal;
const input = { command: "unused", timeoutSeconds: 5 };

test("missing servers files read as an empty list without creating anything", (t) => {
  const path = join(temporary(t), "missing.json");
  assert.deepEqual(readServers(path), { ok: true, servers: [], categories: [] });
  assert.equal(existsSync(path), false);
});

test("write merges serialize credentials only to the private 0600 file", (t) => {
  const path = join(temporary(t), "nested", "servers.json");
  const parsed = parseServersFile(JSON.stringify({ servers: [{ name: "pw", host: "localhost", user: "root", mode: "password", password: "file-only-secret" }] }), path);
  if (!parsed.ok) throw new Error(parsed.error);
  writeServers(path, parsed);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(readServers(path), parsed);
  chmodSync(path, 0o644);
  writeServers(path, parsed);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("askpass is idempotent, private, and contains no credential", (t) => {
  const root = temporary(t);
  const paths = prepareRuntime(join(root, "control"));
  assert.equal(readFileSync(paths.askpassPath, "utf8"), ASKPASS_SCRIPT);
  assert.equal(statSync(paths.askpassPath).mode & 0o777, 0o700);
  assert.equal(statSync(paths.controlDir).mode & 0o777, 0o700);
  const before = statSync(paths.askpassPath).mtimeMs;
  assert.deepEqual(prepareRuntime(paths.controlDir), paths);
  assert.equal(statSync(paths.askpassPath).mtimeMs, before);
  const output = execFileSync(paths.askpassPath, { env: { BB_SSH_SECRET: "secret-with-'quotes-and-$dollars" }, encoding: "utf8" });
  assert.equal(output, "secret-with-'quotes-and-$dollars\n");
  assert.equal(readFileSync(paths.askpassPath, "utf8").includes("secret-with"), false);
});

test("runtime refuses a symlink in place of the control directory or askpass script", (t) => {
  const root = temporary(t);
  const paths = prepareRuntime(join(root, "control"));
  symlinkSync(paths.controlDir, join(root, "link"));
  assert.throws(() => prepareRuntime(join(root, "link")), /directory/);
  rmSync(paths.askpassPath);
  const target = join(root, "protected");
  writeFileSync(target, "do not change");
  symlinkSync(target, paths.askpassPath);
  assert.throws(() => prepareRuntime(paths.controlDir), /regular file/);
  assert.equal(readFileSync(target, "utf8"), "do not change");
});

test("process transport pipes stdin, closes it, captures separate streams, and retains exit code", async () => {
  const result = await runProcess(process.execPath, ["-e", 'process.stdin.on("data", data => process.stdout.write(data));process.stdin.on("end", () => { process.stderr.write("problem"); process.exitCode = 7; });'], {}, { ...input, stdin: "file contents\n" }, signal());
  assert.equal(result.code, 7);
  assert.equal(result.problem, null);
  assert.equal(truncateOutput(result.stdout), "file contents\n");
  assert.equal(truncateOutput(result.stderr), "problem");
});

test("unsupplied stdin is EOF and inherited credentials do not leak", async () => {
  const previous = process.env.BB_SSH_SECRET;
  process.env.BB_SSH_SECRET = "inherited-secret";
  try {
    const result = await runProcess(process.execPath, ["-e", 'process.stdin.resume();process.stdin.on("end", () => process.stdout.write(process.env.BB_SSH_SECRET ?? "clean"));'], {}, input, signal());
    assert.equal(result.code, 0);
    assert.equal(truncateOutput(result.stdout), "clean");
  } finally {
    if (previous === undefined) delete process.env.BB_SSH_SECRET;
    else process.env.BB_SSH_SECRET = previous;
  }
});

test("large output is bounded in memory and contains the final bytes", async () => {
  const result = await runProcess(process.execPath, ["-e", `process.stdout.write("x".repeat(${OUTPUT_LIMIT * 3}) + "last");process.stderr.write("y".repeat(${OUTPUT_LIMIT + 10}));`], {}, input, signal());
  assert.equal(result.code, 0);
  assert.equal(result.stdout.bytes.length, OUTPUT_LIMIT);
  assert.equal(result.stderr.bytes.length, OUTPUT_LIMIT);
  assert.match(truncateOutput(result.stdout), /^\[truncated 131076 bytes\]/);
  assert.ok(truncateOutput(result.stdout).endsWith("last"));
  assert.match(truncateOutput(result.stderr), /^\[truncated 10 bytes\]/);
});

test("timeout terminates a running process and reports the timeout", async () => {
  const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, { ...input, timeoutSeconds: 1 }, signal());
  assert.equal(result.code, null);
  assert.match(result.problem ?? "", /Timed out after 1 seconds/);
  assert.match(formatCommandResult(result), /^exit -1/);
});

test("abort cancels a running process and an already aborted call never spawns", async () => {
  const controller = new AbortController();
  const result = runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {}, input, controller.signal);
  controller.abort();
  assert.equal((await result).problem, "Command cancelled.");
  const skipped = await runProcess("/does-not-exist", [], {}, input, controller.signal);
  assert.equal(skipped.problem, "Command cancelled.");
});

test("a child that ignores SIGTERM is killed after the grace period", async () => {
  const result = await runProcess(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], {}, { ...input, timeoutSeconds: 1 }, signal());
  assert.equal(result.code, null);
  assert.match(result.problem ?? "", /Timed out/);
});

test("spawn failures return a bounded diagnostic", async () => {
  const result = await runProcess("/does-not-exist", [], {}, input, signal());
  assert.match(result.problem ?? "", /Could not start/);
});
