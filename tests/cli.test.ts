import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { sshCli } from "../cli.ts";

function temporary(t: { after: (fn: () => void) => void }) {
  const path = mkdtempSync(join(tmpdir(), "bb-ssh-cli-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
const context = { signal: new AbortController().signal };

test("CLI list supports public JSON and a table without credentials", async (t) => {
  const path = join(temporary(t), "servers.json");
  writeFileSync(path, JSON.stringify({ servers: [
    { name: "pw", host: "localhost", user: "root", mode: "password", password: "sensitive-pw-239" },
    { name: "key", host: "example.com", user: "deploy", mode: "key", passphrase: "sensitive-pp-828" },
  ] }));
  const cli = sshCli(async () => path);
  const json = await cli.run(["list", "--json"], context);
  assert.equal(json.exitCode, 0);
  const data = JSON.parse(json.stdout ?? "");
  assert.equal(data.path, path);
  assert.equal(data.servers.length, 2);
  assert.equal(data.servers[0].mode, "password");
  assert.equal("password" in data.servers[0], false);
  assert.equal("passphrase" in data.servers[1], false);
  const table = await cli.run(["list"], context);
  assert.match(table.stdout ?? "", /NAME\tCATEGORY\tADDRESS\tMODE/);
  for (const result of [json, table]) {
    assert.equal(JSON.stringify(result).includes("sensitive-pw-239"), false);
    assert.equal(JSON.stringify(result).includes("sensitive-pp-828"), false);
  }
});

test("CLI path, help, invalid options, and malformed files", async (t) => {
  const path = join(temporary(t), "servers.json");
  const cli = sshCli(async () => path);
  assert.equal((await cli.run(["path"], context)).stdout, path);
  assert.equal((await cli.run(["--help"], context)).exitCode, 0);
  assert.equal((await cli.run(["list", "--help"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["list", "--unknown"], context)).exitCode, 0);
  writeFileSync(path, "not json private-secret");
  const result = await cli.run(["list", "--json"], context);
  assert.notEqual(result.exitCode, 0);
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});

test("CLI import previews and writes a fixture in an isolated HOME, preserving existing credentials", (t) => {
  const home = temporary(t);
  mkdirSync(join(home, ".ssh"));
  copyFileSync(new URL("./fixtures/ssh-config", import.meta.url), join(home, ".ssh", "config"));
  const path = join(home, ".ssh", "bb-servers.json");
  writeFileSync(path, JSON.stringify({ servers: [{ name: "existing", host: "localhost", user: "root", mode: "password", password: "keep-this-private-462" }] }));
  const before = readFileSync(path, "utf8");
  const run = (write: boolean) => JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `import { sshCli } from './cli.ts'; const result = await sshCli(async () => process.env.SERVERS_PATH).run(${JSON.stringify(write ? ["import", "--write"] : ["import"])}, { signal: new AbortController().signal }); process.stdout.write(JSON.stringify(result));`], { cwd: new URL("..", import.meta.url), env: { ...process.env, HOME: home, SERVERS_PATH: path }, encoding: "utf8" }));
  const preview = run(false);
  assert.equal(preview.exitCode, 0);
  assert.equal(JSON.parse(preview.stdout).servers.length, 5);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(JSON.stringify(preview).includes("keep-this-private-462"), false);
  const write = run(true);
  assert.equal(write.exitCode, 0);
  assert.match(write.stdout, /Imported 4 server/);
  assert.equal(JSON.stringify(write).includes("keep-this-private-462"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).servers[0].password, "keep-this-private-462");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).servers.length, 5);
  assert.match(run(true).stdout, /Imported 0 server/);
  rmSync(path);
  const emptyPreview = run(false);
  assert.equal(emptyPreview.exitCode, 0);
  assert.equal(existsSync(path), false);
});

test("CLI add writes a private entry and remove deletes it", async (t) => {
  const path = join(temporary(t), "servers.json");
  const cli = sshCli(async () => path);
  const added = await cli.run(["add", "vps", "--host", "192.0.2.9", "--user", "ubuntu", "--port", "2200", "--mode", "password", "--password", "cli-pw-771"], context);
  assert.equal(added.exitCode, 0);
  assert.equal(JSON.stringify(added).includes("cli-pw-771"), false);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).servers, [{ name: "vps", host: "192.0.2.9", port: 2200, user: "ubuntu", description: null, category: null, mode: "password", password: "cli-pw-771" }]);
  assert.notEqual((await cli.run(["add", "vps", "--host", "h", "--user", "u", "--mode", "password", "--password", "x"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["add", "nopw", "--host", "h", "--user", "u", "--mode", "password"], context)).exitCode, 0);
  assert.equal((await cli.run(["add", "web", "--host", "example.com", "--user", "root", "--key-path", "~/.ssh/id_ed25519"], context)).exitCode, 0);
  assert.equal((await cli.run(["remove", "vps"], context)).exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).servers.map((server: { name: string }) => server.name), ["web"]);
  assert.notEqual((await cli.run(["remove", "vps"], context)).exitCode, 0);
});

test("CLI category moves, filters, and clears", async (t) => {
  const path = join(temporary(t), "servers.json");
  const cli = sshCli(async () => path);
  assert.equal((await cli.run(["add", "web", "--host", "example.com", "--user", "root", "--category", "Production"], context)).exitCode, 0);
  assert.equal((await cli.run(["add", "db", "--host", "db.example.com", "--user", "root"], context)).exitCode, 0);
  assert.match((await cli.run(["list"], context)).stdout ?? "", /web\tProduction\troot@example\.com:22/);
  assert.deepEqual(JSON.parse((await cli.run(["list", "--json", "--category", "production"], context)).stdout ?? "").servers.map((server: { name: string }) => server.name), ["web"]);
  assert.equal((await cli.run(["category", "db", "Production"], context)).stdout, "Moved db to Production.");
  assert.equal((await cli.run(["category", "web", "--clear"], context)).exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).servers.map((server: { category: string | null }) => server.category), [null, "Production"]);
  assert.notEqual((await cli.run(["category", "web"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["category", "web", "X", "--clear"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["category", "nope", "X"], context)).exitCode, 0);
});

test("CLI new-category moves servers and delete-category only removes empty ones", async (t) => {
  const path = join(temporary(t), "servers.json");
  const cli = sshCli(async () => path);
  for (const name of ["a", "b", "c"]) assert.equal((await cli.run(["add", name, "--host", `${name}.example.com`, "--user", "root"], context)).exitCode, 0);
  assert.equal((await cli.run(["new-category", "Prod", "--server", "a,b"], context)).stdout, "Created Prod with 2 servers.");
  assert.equal((await cli.run(["new-category", "Empty"], context)).stdout, "Created Empty.");
  const file = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(file.categories, ["Prod", "Empty"]);
  assert.deepEqual(file.servers.map((server: { category: string | null }) => server.category), ["Prod", "Prod", null]);
  assert.notEqual((await cli.run(["new-category", "prod"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["delete-category", "Prod"], context)).exitCode, 0);
  assert.equal((await cli.run(["delete-category", "Empty"], context)).exitCode, 0);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).categories, ["Prod"]);
});

test("CLI edit changes only the options given and reports moved chats on rename", async (t) => {
  const path = join(temporary(t), "servers.json");
  const moves: string[][] = [];
  const cli = sshCli(async () => path, async (from, to) => { moves.push([from, to]); return 2; });
  assert.equal((await cli.run(["add", "vps", "--host", "192.0.2.9", "--user", "ubuntu", "--mode", "password", "--password", "keep-me-31"], context)).exitCode, 0);
  assert.equal((await cli.run(["edit", "vps", "--port", "2222", "--category", "Lab"], context)).stdout, "Updated vps.");
  let row = JSON.parse(readFileSync(path, "utf8")).servers[0];
  assert.deepEqual([row.port, row.category, row.password, row.host], [2222, "Lab", "keep-me-31", "192.0.2.9"]);
  const renamed = await cli.run(["edit", "vps", "--new-name", "vps-2", "--category", ""], context);
  assert.equal(renamed.stdout, "Updated vps-2. Moved 2 chat(s) to the new name.");
  assert.deepEqual(moves, [["vps", "vps-2"]]);
  row = JSON.parse(readFileSync(path, "utf8")).servers[0];
  assert.deepEqual([row.name, row.category], ["vps-2", null]);
  assert.notEqual((await cli.run(["edit", "vps-2", "--mode", "key", "--port", "0"], context)).exitCode, 0);
  assert.notEqual((await cli.run(["edit", "ghost", "--port", "22"], context)).exitCode, 0);
});
