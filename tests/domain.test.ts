import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { importSshConfig } from "../import.ts";
import { serverInstructions } from "../instructions.ts";
import { appendOutput, formatCommandResult, OUTPUT_LIMIT, truncateOutput } from "../output.ts";
import { addServer, expandHome, parseServersFile, publicServer, removeServer, serializeServers, setCategory, createCategory, deleteCategory, updateServer, type Server } from "../servers.ts";
import { groupByCategory } from "../groups.ts";
import { sshInvocation } from "../ssh.ts";

const key: Server = { name: "web", host: "example.com", port: 2222, user: "deploy", description: null, category: null, auth: { mode: "key", keyPath: "~/.ssh/id_ed25519", passphrase: null } };
const password: Server = { ...key, name: "password-host", auth: { mode: "password", password: "secret-password-932" } };
const protectedKey: Server = { ...key, auth: { mode: "key", keyPath: "/keys/key", passphrase: "secret-passphrase-341" } };

const state = (...servers: Server[]) => ({ servers, categories: [] as string[] });

function parse(rows: unknown[]) { return parseServersFile(JSON.stringify({ servers: rows }), "/test/servers.json"); }

function goodRows() {
  return [
    { name: "key", host: "example.com", user: "root", mode: "key" },
    { name: "password", host: "192.0.2.2", user: "ubuntu", mode: "password", password: "private-credential", port: 2222 },
  ];
}

test("parse flat key and password entries into the Auth union with defaults", () => {
  const result = parse(goodRows());
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("Expected successful parsing");
  assert.deepEqual(result.servers[0], { name: "key", host: "example.com", user: "root", port: 22, description: null, category: null, auth: { mode: "key", keyPath: null, passphrase: null } });
  assert.deepEqual(result.servers[1].auth, { mode: "password", password: "private-credential" });
  assert.equal(result.servers[1].port, 2222);
  assert.deepEqual(parseServersFile(serializeServers(result), "/test/servers.json"), result);
});

test("a missing file is an empty success", () => {
  assert.deepEqual(parseServersFile(null, "/missing"), { ok: true, servers: [], categories: [] });
});

test("duplicate names and invalid rows identify their row without leaking credentials", () => {
  const invalid = [
    { rows: [goodRows()[0], goodRows()[0]], field: /Row 2.*duplicate/ },
    { rows: [{ ...goodRows()[0], mode: "invalid-secret-value" }], field: /Row 1.*mode/ },
    { rows: [{ ...goodRows()[0], mode: "password" }], field: /Row 1.*password/ },
    { rows: [{ ...goodRows()[0], name: "bad name" }], field: /Row 1.*name/ },
    { rows: [{ ...goodRows()[0], port: 0 }], field: /Row 1.*port/ },
    { rows: [{ ...goodRows()[0], host: "-oProxyCommand=bad" }], field: /Row 1.*host/ },
    { rows: [{ ...goodRows()[0], user: "root@other-host" }], field: /Row 1.*user/ },
  ];
  for (const { rows, field } of invalid) {
    const result = parse(rows);
    assert.equal(result.ok, false);
    if (result.ok) throw new Error("Expected a parse error");
    assert.match(result.error, field);
    assert.equal(result.error.includes("invalid-secret-value"), false);
  }
});

test("malformed JSON and envelope errors never quote the file contents", () => {
  for (const content of ['{"password":"do-not-leak",', '{"servers":"do-not-leak"}', 'null']) {
    const result = parseServersFile(content, "/test/file");
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("do-not-leak"), false);
  }
});

test("public views have no auth, password, or passphrase fields", () => {
  for (const server of [password, protectedKey]) {
    const view = publicServer(server);
    assert.equal(view.mode, server.auth.mode);
    assert.equal("auth" in view, false);
    assert.equal("password" in view, false);
    assert.equal("passphrase" in view, false);
    for (const secret of ["secret-password-932", "secret-passphrase-341"]) assert.equal(JSON.stringify(view).includes(secret), false);
  }
});

test("servers-file home paths expand", () => {
  assert.equal(expandHome("~/servers.json", "/home/test"), "/home/test/servers.json");
  assert.equal(expandHome("~", "/home/test"), "/home/test");
});

test("all SSH plans use the specified noninteractive multiplexed connection options", () => {
  for (const server of [key, password, protectedKey]) {
    const { args } = sshInvocation(server, "/tmp/bb-test", "/data/askpass.sh");
    assert.deepEqual(args.slice(0, 4), ["-T", "-p", "2222", "-o"]);
    for (const option of ["ConnectTimeout=15", "ServerAliveInterval=30", "StrictHostKeyChecking=accept-new", "ControlMaster=auto", "ControlPersist=10m", "ControlPath=/tmp/bb-test/%C"]) assert.ok(args.includes(option));
    assert.equal(args.at(-1), "deploy@example.com");
    for (const secret of ["secret-password-932", "secret-passphrase-341"]) assert.equal(args.join(" ").includes(secret), false);
  }
});

test("password SSH plan disables public keys and supplies its secret only in env", () => {
  const plan = sshInvocation(password, "/tmp/control", "/data/askpass.sh");
  for (const option of ["PreferredAuthentications=password,keyboard-interactive", "PubkeyAuthentication=no", "NumberOfPasswordPrompts=1"]) assert.ok(plan.args.includes(option));
  assert.equal(plan.args.includes("BatchMode=yes"), false);
  assert.deepEqual(plan.env, { SSH_ASKPASS: "/data/askpass.sh", SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":0", BB_SSH_SECRET: "secret-password-932" });
});

test("key SSH plans use BatchMode without a passphrase and askpass with one", () => {
  const plan = sshInvocation(key, "/tmp/control", "/data/askpass.sh");
  assert.ok(plan.args.includes("IdentitiesOnly=yes"));
  assert.equal(plan.args[plan.args.indexOf("-i") + 1], "~/.ssh/id_ed25519");
  assert.ok(plan.args.includes("BatchMode=yes"));
  assert.deepEqual(plan.env, {});
  const agentPlan = sshInvocation({ ...key, auth: { mode: "key", keyPath: null, passphrase: null } }, "/tmp/control", "/data/askpass.sh");
  assert.equal(agentPlan.args.includes("-i"), false);
  assert.equal(agentPlan.args.includes("IdentitiesOnly=yes"), false);
  const encrypted = sshInvocation(protectedKey, "/tmp/control", "/data/askpass.sh");
  assert.equal(encrypted.args.includes("BatchMode=yes"), false);
  assert.equal(encrypted.env.BB_SSH_SECRET, "secret-passphrase-341");
});

test("config import handles aliases, quotes, defaults, first values, and existing names", () => {
  const fixture = readFileSync(new URL("./fixtures/ssh-config", import.meta.url), "utf8");
  const existing: Server = { ...password, name: "existing" };
  const result = importSshConfig(fixture, [existing], "local-user");
  assert.deepEqual(result.map(({ name }) => name), ["existing", "web", "web-backup", "api", "defaults"]);
  assert.deepEqual(result[0], existing);
  assert.deepEqual(result[1], { name: "web", host: "web.example.com", user: "deploy", port: 2222, description: null, category: null, auth: { mode: "key", keyPath: "~/.ssh/web key", passphrase: null } });
  assert.deepEqual(result[3].auth, { mode: "key", keyPath: "~/.ssh/api.example.com-ubuntu", passphrase: null });
  assert.equal(result[4].host, "defaults");
  assert.equal(result[4].user, "local-user");
  assert.equal(result[4].port, 22);
  assert.deepEqual(importSshConfig(fixture, result, "local-user"), result);
});

test("output keeps the last 64 KiB across chunks and counts omitted bytes", () => {
  const tail = appendOutput(appendOutput({ bytes: Buffer.alloc(0), total: 0 }, Buffer.alloc(OUTPUT_LIMIT, "x")), Buffer.from("THE END"));
  assert.equal(tail.bytes.length, OUTPUT_LIMIT);
  assert.equal(tail.total, OUTPUT_LIMIT + 7);
  const output = truncateOutput(tail);
  assert.ok(output.startsWith("[truncated 7 bytes]\n"));
  assert.ok(output.endsWith("THE END"));
  assert.equal(truncateOutput({ bytes: Buffer.from("hello"), total: 5 }), "hello");
});

test("truncation avoids starting inside a UTF-8 character", () => {
  const tail = appendOutput({ bytes: Buffer.alloc(0), total: 0 }, Buffer.from("€€!"), 5);
  assert.equal(truncateOutput(tail), "[truncated 3 bytes]\n€!");
});

test("command results keep exit status and output intact, even when it matches a password", () => {
  const text = formatCommandResult({ code: 3, stdout: { bytes: Buffer.from("root ok"), total: 7 }, stderr: { bytes: Buffer.from("failed"), total: 6 }, problem: null });
  assert.equal(text, "exit 3\nstdout:\nroot ok\nstderr:\nfailed");
});

test("instructions quote server data, explain shell limits and require destructive confirmation", () => {
  const server = { ...password, description: 'A note with "quotes" and\nnewlines. ' + 'x'.repeat(5000) };
  const instructions = serverInstructions(server);
  assert.ok(instructions.length < 4096);
  for (const text of ['"password-host"', "deploy@example.com:2222", "ssh_exec", "fresh non-interactive shell", "cat > path", "stdin", "Confirm with the user", "firewall changes"]) assert.ok(instructions.includes(text));
  assert.equal(instructions.includes("secret-password-932"), false);
});

test("addServer validates the new row and refuses a duplicate name", () => {
  const added = addServer(state(key), { name: "vps", host: "192.0.2.9", user: "ubuntu", port: 2200, mode: "password", password: "pw-123" });
  assert.equal(added.ok, true);
  if (!added.ok) throw new Error("Expected the server to be added");
  assert.deepEqual(added.servers.at(-1), { name: "vps", host: "192.0.2.9", user: "ubuntu", port: 2200, description: null, category: null, auth: { mode: "password", password: "pw-123" } });
  assert.deepEqual(addServer(state(key), { name: "web", host: "x.example", user: "root", mode: "key" }), { ok: false, error: "A server named web already exists." });
  const missing = addServer(state(key), { name: "vps", host: "192.0.2.9", user: "ubuntu", mode: "password" });
  assert.equal(missing.ok, false);
  if (missing.ok) throw new Error("Expected a validation error");
  assert.match(missing.error, /^password:/);
});

test("removeServer drops the named server and reports an unknown name", () => {
  assert.deepEqual(removeServer(state(key, password), "web"), { ok: true, servers: [password], categories: [] });
  assert.deepEqual(removeServer(state(key), "nope"), { ok: false, error: "No server named nope." });
});

test("category is optional, trimmed, and blank means no category", () => {
  const result = parse([
    { name: "a", host: "a.example", user: "root", mode: "key", category: "  Production " },
    { name: "b", host: "b.example", user: "root", mode: "key", category: "   " },
    { name: "c", host: "c.example", user: "root", mode: "key" },
  ]);
  if (!result.ok) throw new Error(result.error);
  assert.deepEqual(result.servers.map(({ category }) => category), ["Production", null, null]);
  assert.equal(publicServer(result.servers[0]).category, "Production");
  assert.equal(parse([{ name: "a", host: "a.example", user: "root", mode: "key", category: "x".repeat(65) }]).ok, false);
});

test("setCategory moves one server, clears with null, and rejects unknown names", () => {
  const moved = setCategory(state(key, password), "web", "Staging");
  assert.deepEqual(moved.ok && moved.servers.map(({ name, category }) => [name, category]), [["web", "Staging"], ["password-host", null]]);
  const cleared = moved.ok ? setCategory(moved, "web", null) : moved;
  assert.equal(cleared.ok && cleared.servers[0].category, null);
  assert.deepEqual(setCategory(state(key), "nope", "X"), { ok: false, error: "No server named nope." });
  assert.equal(setCategory(state(key), "web", "x".repeat(65)).ok, false);
});

test("groupByCategory sorts named categories and keeps uncategorized last in original order", () => {
  const rows = [{ name: "1", category: null }, { name: "2", category: "Staging" }, { name: "3", category: "Production" }, { name: "4", category: null }, { name: "5", category: "Staging" }];
  assert.deepEqual(groupByCategory(rows).map(({ category, servers }) => [category, servers.map(({ name }) => name)]), [
    ["Production", ["3"]], ["Staging", ["2", "5"]], [null, ["1", "4"]],
  ]);
});

test("declared categories survive a round trip and include every category a server uses", () => {
  const result = parseServersFile(JSON.stringify({ categories: [" Lab ", "Lab"], servers: [{ name: "a", host: "a.example", user: "root", mode: "key", category: "Prod" }] }), "/test/servers.json");
  if (!result.ok) throw new Error(result.error);
  assert.deepEqual(result.categories, ["Lab", "Prod"]);
  assert.deepEqual(parseServersFile(serializeServers(result), "/test/servers.json"), result);
  assert.equal(JSON.parse(serializeServers(state(key))).categories, undefined);
  assert.equal(parseServersFile(JSON.stringify({ categories: [""], servers: [] }), "/x").ok, false);
});

test("createCategory declares an empty category or moves chosen servers into it", () => {
  const empty = createCategory(state(key, password), " Staging ", []);
  assert.deepEqual(empty.ok && [empty.categories, empty.servers.map(({ category }) => category)], [["Staging"], [null, null]]);
  const filled = createCategory(state(key, password), "Prod", ["password-host"]);
  assert.deepEqual(filled.ok && filled.servers.map(({ category }) => category), [null, "Prod"]);
  assert.deepEqual(createCategory({ servers: [key], categories: ["Prod"] }, "prod", []), { ok: false, error: "A category named Prod already exists." });
  assert.deepEqual(createCategory(state(key), "X", ["ghost"]), { ok: false, error: "No server named ghost." });
  assert.equal(createCategory(state(key), "   ", []).ok, false);
});

test("deleteCategory removes only an empty declared category", () => {
  assert.deepEqual(deleteCategory({ servers: [key], categories: ["Lab"] }, "Lab"), { ok: true, servers: [key], categories: [] });
  assert.deepEqual(deleteCategory({ servers: [{ ...key, category: "Lab" }], categories: ["Lab"] }, "Lab"), { ok: false, error: "Move the 1 server out of Lab before deleting it." });
  assert.deepEqual(deleteCategory(state(key), "Lab"), { ok: false, error: "No category named Lab." });
});

test("setCategory and addServer declare the category they use", () => {
  const moved = setCategory(state(key), "web", "Edge");
  assert.deepEqual(moved.ok && moved.categories, ["Edge"]);
  const cleared = moved.ok ? setCategory(moved, "web", null) : moved;
  assert.deepEqual(cleared.ok && cleared.categories, ["Edge"]);
  const added = addServer(state(), { name: "n", host: "n.example", user: "root", mode: "key", category: "New" });
  assert.deepEqual(added.ok && added.categories, ["New"]);
});

test("groupByCategory shows declared categories even when empty", () => {
  assert.deepEqual(groupByCategory([{ name: "1", category: "B" }], ["A", "B"]).map(({ category, servers }) => [category, servers.length]), [["A", 0], ["B", 1]]);
});

test("updateServer keeps secrets left blank and replaces fields that were sent", () => {
  const edited = updateServer(state(password, key), "password-host", { host: "203.0.113.7", port: 2201, password: "", description: "Edge", category: "Prod" });
  if (!edited.ok) throw new Error(edited.error);
  assert.deepEqual(edited.servers[0], { ...password, host: "203.0.113.7", port: 2201, description: "Edge", category: "Prod" });
  assert.deepEqual(edited.categories, ["Prod"]);
  const newPassword = updateServer(state(password), "password-host", { password: "rotated-1" });
  assert.deepEqual(newPassword.ok && newPassword.servers[0].auth, { mode: "password", password: "rotated-1" });
  const cleared = updateServer(state(protectedKey), "web", { keyPath: null, description: "", passphrase: "" });
  assert.deepEqual(cleared.ok && [cleared.servers[0].auth, cleared.servers[0].description], [{ mode: "key", keyPath: null, passphrase: "secret-passphrase-341" }, null]);
});

test("updateServer switches auth mode, renames, and refuses collisions", () => {
  const toKey = updateServer(state(password), "password-host", { mode: "key", keyPath: "~/.ssh/id_ed25519" });
  assert.deepEqual(toKey.ok && toKey.servers[0].auth, { mode: "key", keyPath: "~/.ssh/id_ed25519", passphrase: null });
  const noPassword = updateServer(state(key), "web", { mode: "password" });
  assert.equal(noPassword.ok, false);
  const toPassword = updateServer(state(key), "web", { mode: "password", password: "pw-9" });
  assert.deepEqual(toPassword.ok && toPassword.servers[0].auth, { mode: "password", password: "pw-9" });
  const renamed = updateServer(state(key, password), "web", { name: "web-2" });
  assert.deepEqual(renamed.ok && renamed.servers.map(({ name }) => name), ["web-2", "password-host"]);
  assert.deepEqual(updateServer(state(key, password), "web", { name: "password-host" }), { ok: false, error: "A server named password-host already exists." });
  assert.deepEqual(updateServer(state(key), "ghost", {}), { ok: false, error: "No server named ghost." });
});
