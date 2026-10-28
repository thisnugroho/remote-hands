import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendOutput, type CommandResult } from "./output.ts";
import { parseServersFile, serializeServers, type Server, type ServersChange, type ServersFile, type ServersState } from "./servers.ts";
import { sshInvocation } from "./ssh.ts";

export type RuntimePaths = { controlDir: string; askpassPath: string };
export const ASKPASS_SCRIPT = '#!/bin/sh\nprintf \'%s\\n\' "$BB_SSH_SECRET"\n';

export function readServers(path: string): ServersFile {
  try { return parseServersFile(readFileSync(path, "utf8"), path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return parseServersFile(null, path);
    return { ok: false, path, error: "Cannot read servers file. Check its path and permissions." };
  }
}

export function writeServers(path: string, state: ServersState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.bb-ssh-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, serializeServers(state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
}

export function changeServers(path: string, change: (state: ServersState) => ServersChange): string | null {
  const file = readServers(path);
  if (!file.ok) return file.error;
  const next = change(file);
  if (!next.ok) return next.error;
  writeServers(path, next);
  return null;
}

export function prepareRuntime(controlDir = `/tmp/bb-ssh-${process.getuid?.() ?? "user"}`): RuntimePaths {
  mkdirSync(controlDir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(controlDir);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error("SSH runtime directory must be owned by the current user.");
  chmodSync(controlDir, 0o700);
  const askpassPath = join(controlDir, "askpass.sh");
  try {
    if (!lstatSync(askpassPath).isFile()) throw new Error("SSH askpass path must be a regular file.");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700, flag: "wx" });
  }
  if (readFileSync(askpassPath, "utf8") !== ASKPASS_SCRIPT) writeFileSync(askpassPath, ASKPASS_SCRIPT, { mode: 0o700 });
  chmodSync(askpassPath, 0o700);
  return { controlDir, askpassPath };
}

export type CommandInput = { command: string; stdin?: string; timeoutSeconds: number };

export function runSsh(server: Server, paths: RuntimePaths, input: CommandInput, signal: AbortSignal): Promise<CommandResult> {
  const invocation = sshInvocation(server, paths.controlDir, paths.askpassPath);
  return runProcess("/usr/bin/ssh", [...invocation.args, "--", input.command], invocation.env, input, signal);
}

export function runProcess(binary: string, args: string[], environment: Record<string, string>, input: CommandInput, signal: AbortSignal): Promise<CommandResult> {
  const result: CommandResult = {
    code: null, stdout: { bytes: Buffer.alloc(0), total: 0 }, stderr: { bytes: Buffer.alloc(0), total: 0 }, problem: null,
  };
  if (signal.aborted) return Promise.resolve({ ...result, problem: "Command cancelled." });
  return new Promise((resolve) => {
    const env = { ...process.env, BB_SSH_SECRET: undefined, SSH_ASKPASS: undefined, SSH_ASKPASS_REQUIRE: undefined, ...environment };
    const child = spawn(binary, args, { env, stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = (problem: string) => {
      if (result.problem !== null) return;
      result.problem = problem;
      child.kill("SIGTERM");
      escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
      escalation.unref();
    };
    const abort = () => stop("Command cancelled.");
    const timer = setTimeout(() => stop(`Timed out after ${input.timeoutSeconds} seconds.`), input.timeoutSeconds * 1000);
    signal.addEventListener("abort", abort, { once: true });
    child.stdout?.on("data", (chunk: Buffer) => { result.stdout = appendOutput(result.stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { result.stderr = appendOutput(result.stderr, chunk); });
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") stop("Could not send command stdin.");
    });
    child.on("error", () => { result.problem ??= "Could not start the SSH process."; });
    child.on("close", (code, killedBy) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      signal.removeEventListener("abort", abort);
      result.code = code;
      if (killedBy !== null) result.problem ??= `SSH process terminated by ${killedBy}.`;
      resolve(result);
    });
    if (signal.aborted) abort();
    child.stdin?.end(input.stdin);
  });
}
