import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test, type TestContext } from "node:test";
import { createFakePluginHost, experimental_scanPublicSdkOnly, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin, { rpcContract } from "../server.ts";

async function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "bb-ssh-server-"));
  const path = join(root, "servers.json");
  writeFileSync(path, JSON.stringify({ servers: [
    { name: "pw", host: "localhost", user: "root", mode: "password", password: "private-password-462", description: "Production" },
    { name: "key", host: "example.com", user: "deploy", mode: "key", keyPath: "~/.ssh/id_test", passphrase: "private-passphrase-927" },
  ] }));
  const { bb, harness } = createFakePluginHost({
    pluginId: "ssh", agentSkillIds: ["ssh"], settings: { serversFile: path },
    sdk: {
      projects: { list: async () => [{ id: "personal-project", kind: "personal", name: "Personal", gitRemoteUrl: null, createdAt: 1, updatedAt: 1, sources: [] }] },
      threads: { spawn: async () => makeThreadResponse({ id: "ssh-thread" }), getPluginMetadata: async () => ({ server: "pw" }) },
    },
  });
  const database = mock.method(bb.storage, "database", () => ({ name: join(root, "data.db") }));
  t.after(async () => { await harness.dispose(); database.mock.restore(); rmSync(root, { recursive: true, force: true }); });
  await plugin(bb);
  return { root, path, bb, harness };
}

test("RPC list returns public views and startChat seeds the personal-project thread", async (t) => {
  const { harness } = await setup(t);
  const result = await harness.callRpc("listServers");
  const data = rpcContract.listServers.output.parse(result);
  assert.equal(data.servers.length, 2);
  assert.equal(data.error, null);
  for (const secret of ["private-password-462", "private-passphrase-927"]) assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(await harness.callRpc("startChat", { name: "pw" }), { threadId: "ssh-thread" });
  const calls = harness.sdk.callsTo("threads.spawn");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{
    projectId: "personal-project", environment: { type: "project-default" }, title: "SSH · pw", pluginMetadata: { server: "pw" },
    prompt: "Connect to the server and give me a short status: hostname, OS, uptime, load, disk and memory usage. Then wait for my instructions.",
    origin: "plugin", originPluginId: "ssh",
  }]);
  await assert.rejects(harness.callRpc("startChat", { name: "missing" }), /Server not found/);
  assert.equal(harness.sdk.callsTo("threads.spawn").length, 1);
});

test("RPC file errors identify the path without disclosing malformed contents", async (t) => {
  const { path, harness } = await setup(t);
  writeFileSync(path, '{"private-password-462":');
  const result = rpcContract.listServers.output.parse(await harness.callRpc("listServers"));
  assert.equal(result.path, path);
  assert.deepEqual(result.servers, []);
  assert.match(result.error ?? "", /Invalid JSON/);
  assert.equal(JSON.stringify(result).includes("private-password-462"), false);
});

test("configure selects only known metadata servers and observes live settings and file changes", async (t) => {
  const { root, path, harness } = await setup(t);
  const selected = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { server: "pw" } }));
  assert.deepEqual(selected.tools.map(({ name }) => name), ["ssh_exec"]);
  assert.deepEqual(selected.skills, ["ssh"]);
  assert.match(selected.instructions ?? "", /remote server "pw"/);
  assert.equal((selected.instructions ?? "").includes("private-password-462"), false);
  for (const name of [null, "missing", 12]) {
    const result = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: name === null ? {} : { server: name } }));
    assert.deepEqual(result.tools, []);
  }
  writeFileSync(path, JSON.stringify({ servers: [] }));
  assert.deepEqual((await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { server: "pw" } }))).tools, []);
  const newPath = join(root, "new.json");
  writeFileSync(newPath, JSON.stringify({ servers: [{ name: "new", host: "localhost", user: "root", mode: "key" }] }));
  await harness.setSettings({ serversFile: newPath });
  const next = await harness.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { server: "new" } }));
  assert.deepEqual(next.tools.map(({ name }) => name), ["ssh_exec"]);
});

test("tool resolves metadata, honors cancellation, and validates byte and timeout boundaries", async (t) => {
  const { harness } = await setup(t);
  const controller = new AbortController();
  controller.abort();
  const result = await harness.callAgentTool("ssh_exec", { command: "hostname" }, { signal: controller.signal });
  assert.equal(typeof result, "object");
  if (typeof result === "string") throw new Error("Expected structured tool result");
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /Command cancelled/);
  assert.deepEqual(harness.sdk.callsTo("threads.getPluginMetadata")[0], [{ threadId: "thread-test", pluginId: "ssh" }]);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ server: "unknown" }));
  const unknown = await harness.callAgentTool("ssh_exec", { command: "hostname" });
  assert.match(JSON.stringify(unknown), /No configured server/);
  for (const params of [
    { command: "" }, { command: "ls", timeoutSeconds: 0 }, { command: "ls", timeoutSeconds: 1801 },
    { command: "ls", stdin: "€".repeat(350000) }, { command: "ls", server: "key" },
  ]) await assert.rejects(harness.callAgentTool("ssh_exec", params));
});

test("RPC addServer and removeServer change the file and report validation errors", async (t) => {
  const { harness, path } = await setup(t);
  assert.deepEqual(await harness.callRpc("addServer", { name: "new", host: "192.0.2.5", user: "root", port: 22, mode: "password", password: "rpc-pw-55" }), { error: null });
  const listed = rpcContract.listServers.output.parse(await harness.callRpc("listServers"));
  assert.deepEqual(listed.servers.map(({ name }) => name), ["pw", "key", "new"]);
  assert.equal(JSON.stringify(listed).includes("rpc-pw-55"), false);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).servers[0].password, "private-password-462");
  assert.deepEqual(await harness.callRpc("addServer", { name: "new", host: "h", user: "u", mode: "key" }), { error: "A server named new already exists." });
  assert.deepEqual(await harness.callRpc("setCategory", { name: "new", category: "Lab" }), { error: null });
  assert.equal(rpcContract.listServers.output.parse(await harness.callRpc("listServers")).servers.find(({ name }) => name === "new")?.category, "Lab");
  assert.deepEqual(await harness.callRpc("setCategory", { name: "ghost", category: "Lab" }), { error: "No server named ghost." });
  assert.deepEqual(await harness.callRpc("createCategory", { name: "Ops", servers: ["key"] }), { error: null, category: "Ops" });
  assert.deepEqual(await harness.callRpc("createCategory", { name: "Empty", servers: [] }), { error: null, category: "Empty" });
  const grouped = rpcContract.listServers.output.parse(await harness.callRpc("listServers"));
  assert.deepEqual(grouped.categories, ["Lab", "Ops", "Empty"]);
  assert.equal(grouped.servers.find(({ name }) => name === "key")?.category, "Ops");
  assert.deepEqual(await harness.callRpc("deleteCategory", { name: "Ops" }), { error: "Move the 1 server out of Ops before deleting it." });
  assert.deepEqual(await harness.callRpc("deleteCategory", { name: "Empty" }), { error: null });
  harness.sdk.stub("threads.list", async ({ archived }: { archived: boolean }) => (archived ? [] : [makeThreadResponse({ id: "t1" }), makeThreadResponse({ id: "t2" })]));
  harness.sdk.stub("threads.experimental_listPluginMetadata", async () => ({ threads: [{ threadId: "t1", metadata: { server: "new" } }, { threadId: "t2", metadata: { server: "pw" } }] }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({ server: "renamed" }));
  assert.deepEqual(await harness.callRpc("updateServer", { originalName: "new", server: { name: "renamed", host: "192.0.2.5", port: 2200, user: "root", mode: "password" } }), { error: null, movedChats: 1 });
  assert.deepEqual(harness.sdk.callsTo("threads.updatePluginMetadata").map(([args]) => args), [{ threadId: "t1", set: { server: "renamed" }, pluginId: "ssh" }]);
  const saved = JSON.parse(readFileSync(path, "utf8")).servers.find(({ name }: { name: string }) => name === "renamed");
  assert.deepEqual([saved.port, saved.password], [2200, "rpc-pw-55"]);
  assert.deepEqual(await harness.callRpc("updateServer", { originalName: "renamed", server: { name: "pw", host: "h", port: 22, user: "u", mode: "key" } }), { error: "A server named pw already exists.", movedChats: 0 });
  assert.deepEqual(await harness.callRpc("removeServer", { name: "renamed" }), { error: null });
  assert.deepEqual(await harness.callRpc("removeServer", { name: "new" }), { error: "No server named new." });
});

test("only public SDK dependencies are imported", () => {
  const result = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname, {
    allow: [/^react$/, /^@radix-ui\/react-slot$/, /^(class-variance-authority|clsx|tailwind-merge)$/],
  });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.privateDependencies, []);
});
