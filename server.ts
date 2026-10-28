import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { sshCli } from "./cli.ts";
import { serverInstructions } from "./instructions.ts";
import { formatCommandResult } from "./output.ts";
import { changeServers, prepareRuntime, readServers, runSsh, type RuntimePaths } from "./runtime.ts";
import { addServer, createCategory, deleteCategory, expandHome, publicServer, publicServerSchema, removeServer, setCategory, updateServer } from "./servers.ts";

export const rpcContract = defineRpcContract({
  listServers: {
    input: z.null(),
    output: z.object({ path: z.string(), servers: z.array(publicServerSchema), categories: z.array(z.string()), error: z.string().nullable() }),
  },
  startChat: {
    input: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]+$/) }).strict(),
    output: z.object({ threadId: z.string() }),
  },
  addServer: {
    input: z.object({
      name: z.string(), host: z.string(), port: z.number().optional(), user: z.string(), mode: z.enum(["key", "password"]),
      password: z.string().optional(), keyPath: z.string().optional(), passphrase: z.string().optional(), description: z.string().optional(), category: z.string().optional(),
    }).strict(),
    output: z.object({ error: z.string().nullable() }),
  },
  removeServer: {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ error: z.string().nullable() }),
  },
  updateServer: {
    input: z.object({
      originalName: z.string(),
      server: z.object({
        name: z.string(), host: z.string(), port: z.number(), user: z.string(), mode: z.enum(["key", "password"]),
        password: z.string().optional(), keyPath: z.string().nullable().optional(), passphrase: z.string().optional(),
        description: z.string().nullable().optional(), category: z.string().nullable().optional(),
      }).strict(),
    }).strict(),
    output: z.object({ error: z.string().nullable(), movedChats: z.number() }),
  },
  createCategory: {
    input: z.object({ name: z.string(), servers: z.array(z.string()).max(1000) }).strict(),
    output: z.object({ error: z.string().nullable(), category: z.string().nullable() }),
  },
  deleteCategory: {
    input: z.object({ name: z.string() }).strict(),
    output: z.object({ error: z.string().nullable() }),
  },
  setCategory: {
    input: z.object({ name: z.string(), category: z.string().nullable() }).strict(),
    output: z.object({ error: z.string().nullable() }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serversFile: { type: "string", label: "Servers file on the BB server", default: "~/.ssh/bb-servers.json" },
  });
  let serversPath = expandHome((await settings.get()).serversFile);
  settings.onChange((next) => { serversPath = expandHome(next.serversFile); });
  let paths: RuntimePaths | null = null;

  async function moveChats(from: string, to: string): Promise<number> {
    let moved = 0;
    for (const archived of [false, true]) {
      for (let offset = 0; ; offset += 200) {
        const threads = await bb.sdk.threads.list({ originPluginId: "ssh", archived, includeHidden: true, limit: 200, offset });
        if (threads.length === 0) break;
        const { threads: tagged } = await bb.sdk.threads.experimental_listPluginMetadata({ threadIds: threads.map(({ id }) => id) });
        for (const { threadId, metadata } of tagged) {
          if (metadata.server !== from) continue;
          await bb.sdk.threads.updatePluginMetadata({ threadId, set: { server: to } });
          moved += 1;
        }
        if (threads.length < 200) break;
      }
    }
    return moved;
  }

  bb.rpc.register(rpcContract, {
    listServers() {
      const file = readServers(serversPath);
      if (!file.ok) return { path: serversPath, servers: [], categories: [], error: file.error };
      return { path: serversPath, servers: file.servers.map(publicServer), categories: file.categories, error: null };
    },
    addServer(row) {
      return { error: changeServers(serversPath, (state) => addServer(state, row)) };
    },
    removeServer({ name }) {
      return { error: changeServers(serversPath, (state) => removeServer(state, name)) };
    },
    async updateServer({ originalName, server }) {
      const error = changeServers(serversPath, (state) => updateServer(state, originalName, server));
      if (error !== null || server.name === originalName) return { error, movedChats: 0 };
      try { return { error: null, movedChats: await moveChats(originalName, server.name) }; }
      catch { return { error: `Saved, but chats started on ${originalName} could not be moved to ${server.name}.`, movedChats: 0 }; }
    },
    createCategory({ name, servers }) {
      const error = changeServers(serversPath, (state) => createCategory(state, name, servers));
      return { error, category: error === null ? name.trim() : null };
    },
    deleteCategory({ name }) {
      return { error: changeServers(serversPath, (state) => deleteCategory(state, name)) };
    },
    setCategory({ name, category }) {
      return { error: changeServers(serversPath, (state) => setCategory(state, name, category)) };
    },
    async startChat({ name }) {
      const file = readServers(serversPath);
      if (!file.ok) throw new Error(file.error);
      const server = file.servers.find((server) => server.name === name);
      if (server === undefined) throw new Error("Server not found. Refresh the Remote Hands panel.");
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      const project = projects.find(({ kind }) => kind === "personal");
      if (project === undefined) throw new Error("The personal project is unavailable.");
      const thread = await bb.sdk.threads.spawn({
        projectId: project.id,
        environment: { type: "project-default" },
        title: `SSH · ${server.name}`,
        pluginMetadata: { server: server.name },
        prompt: "Connect to the server and give me a short status: hostname, OS, uptime, load, disk and memory usage. Then wait for my instructions.",
      });
      return { threadId: thread.id };
    },
  });

  bb.agents.registerTool({
    name: "ssh_exec",
    description: "Run a non-interactive shell command on this chat's remote SSH server.",
    parameters: z.object({
      command: z.string().min(1).refine((value) => !value.includes("\0"), "Command must not contain NUL"),
      stdin: z.string().max(1024 * 1024).refine((value) => Buffer.byteLength(value, "utf8") <= 1024 * 1024, "stdin must be at most 1 MiB").optional(),
      timeoutSeconds: z.number().int().min(1).max(1800).default(120),
    }).strict(),
    presentation: { label: { pending: "Running on server", completed: "Ran on server" }, icon: { glyph: "Terminal" } },
    async execute(input, context) {
      const file = readServers(serversPath);
      const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
      if (!file.ok) return fail(file.error);
      try {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: context.threadId });
        const server = file.servers.find(({ name }) => name === metadata.server);
        if (server === undefined) return fail("No configured server is selected for this thread. Start a chat from the Remote Hands panel.");
        paths ??= prepareRuntime();
        const result = await runSsh(server, paths, input, context.signal);
        return { isError: result.code !== 0 || result.problem !== null, content: [{ type: "text", text: formatCommandResult(result) }] };
      } catch {
        return fail("Could not execute on this thread's SSH server. Check the server configuration and try again.");
      }
    },
  });

  bb.agents.configure((context) => {
    const name = context.pluginMetadata.server;
    if (typeof name !== "string") return { tools: [], skills: [] };
    const file = readServers(serversPath);
    if (!file.ok) return { tools: [], skills: [] };
    const server = file.servers.find((server) => server.name === name);
    return server === undefined ? { tools: [], skills: [] } : {
      tools: ["ssh_exec"], skills: ["ssh"], instructions: serverInstructions(server),
    };
  });

  bb.cli.register(sshCli(async () => serversPath, moveChats));
}
