import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { cliCommand, defineCli, PluginCliError } from "@get-bb/plugin-sdk";
import { importSshConfig } from "./import.ts";
import { changeServers, readServers, writeServers } from "./runtime.ts";
import { addServer, createCategory, deleteCategory, expandHome, publicServer, removeServer, setCategory, updateServer } from "./servers.ts";

export function sshCli(getPath: () => Promise<string>, moveChats: (from: string, to: string) => Promise<number> = async () => 0) {
  return defineCli({
    name: "ssh",
    summary: "List SSH servers, import SSH config, or locate the servers file",
    commands: {
      list: cliCommand({
        summary: "List configured SSH servers without credentials",
        options: {
          json: { type: "boolean", description: "Print public server fields as JSON" },
          category: { type: "string", aliases: ["group"], description: "Only list servers in this category (case-insensitive)" },
        },
        async run({ options }) {
          const path = await getPath();
          const file = readServers(path);
          if (!file.ok) throw new PluginCliError(file.error, { code: "invalid_servers_file", hint: `Check ${path}.` });
          const wanted = options.category?.trim().toLowerCase();
          const servers = file.servers.map(publicServer).filter((server) => wanted === undefined || server.category?.toLowerCase() === wanted);
          const text = options.json ? JSON.stringify({ path, servers }, null, 2) : [
            "NAME\tCATEGORY\tADDRESS\tMODE\tDESCRIPTION",
            ...servers.map((server) => `${server.name}\t${server.category ?? "-"}\t${server.user}@${server.host}:${server.port}\t${server.mode}\t${server.description ?? ""}`),
            ...(servers.length === 0 ? ["No servers. Run bb ssh import to preview an import."] : []),
          ].join("\n");
          return { exitCode: 0, stdout: text };
        },
      }),
      import: cliCommand({
        summary: "Preview SSH config imports, or merge them with --write",
        options: { write: { type: "boolean", description: "Write the merged servers file with permissions 0600" } },
        async run({ options }) {
          const path = await getPath();
          const file = readServers(path);
          if (!file.ok) throw new PluginCliError(file.error, { code: "invalid_servers_file" });
          let config: string;
          try { config = readFileSync(expandHome("~/.ssh/config"), "utf8"); }
          catch { throw new PluginCliError("Cannot read ~/.ssh/config. Check that it exists and is readable.", { code: "ssh_config_unreadable" }); }
          const merged = importSshConfig(config, file.servers, userInfo().username);
          if (options.write) {
            writeServers(path, { servers: merged, categories: file.categories });
            return { exitCode: 0, stdout: `Imported ${merged.length - file.servers.length} server(s) into ${path}.` };
          }
          return {
            exitCode: 0,
            stdout: JSON.stringify({ servers: merged.map(publicServer) }, null, 2),
            stderr: "Preview only. Credentials are omitted. Run bb ssh import --write to merge the file.",
          };
        },
      }),
      add: cliCommand({
        summary: "Add an SSH server to the servers file",
        positionals: [{ name: "name", description: "Unique server name: letters, numbers, dots, underscores, hyphens", required: true }],
        options: {
          host: { type: "string", required: true, aliases: ["hostname"], description: "Hostname or IP address" },
          user: { type: "string", required: true, aliases: ["username"], description: "Login user" },
          port: { type: "integer", min: 1, max: 65535, default: 22, description: "SSH port (default 22)" },
          mode: { type: "enum", values: ["key", "password"], default: "key", aliases: ["auth"], description: "Authentication: key (default) or password" },
          "key-path": { type: "string", aliases: ["identity-file", "key"], description: "Private key path for key mode; omit to use ssh defaults" },
          password: { type: "string", stdin: true, description: "Password for password mode; prefer --password-stdin" },
          passphrase: { type: "string", stdin: true, description: "Key passphrase for key mode; prefer --passphrase-stdin" },
          description: { type: "string", description: "Optional note shown in the Remote Hands panel and to the agent" },
          category: { type: "string", aliases: ["group"], description: "Optional category used to group servers, at most 64 characters" },
        },
        async run({ positionals, options }) {
          const path = await getPath();
          const row = {
            name: positionals.name, host: options.host, user: options.user, port: options.port, mode: options.mode,
            ...(options["key-path"] === undefined ? {} : { keyPath: options["key-path"] }),
            ...(options.password === undefined ? {} : { password: options.password }),
            ...(options.passphrase === undefined ? {} : { passphrase: options.passphrase }),
            ...(options.description === undefined ? {} : { description: options.description }),
            ...(options.category === undefined ? {} : { category: options.category }),
          };
          const error = changeServers(path, (state) => addServer(state, row));
          if (error !== null) throw new PluginCliError(error, { code: "add_failed", hint: "Run bb ssh add --help." });
          return { exitCode: 0, stdout: `Added ${positionals.name} to ${path}.` };
        },
      }),
      edit: cliCommand({
        summary: "Change a server's fields; omitted options keep their current value",
        positionals: [{ name: "name", description: "Current server name from bb ssh list", required: true }],
        options: {
          "new-name": { type: "string", aliases: ["rename"], description: "New server name; chats on the old name move with it" },
          host: { type: "string", aliases: ["hostname"], description: "Hostname or IP address" },
          user: { type: "string", aliases: ["username"], description: "Login user" },
          port: { type: "integer", min: 1, max: 65535, description: "SSH port" },
          mode: { type: "enum", values: ["key", "password"], aliases: ["auth"], description: "Authentication; switching to password needs --password-stdin" },
          "key-path": { type: "string", aliases: ["identity-file", "key"], description: "Private key path; pass an empty string to use ssh defaults" },
          password: { type: "string", stdin: true, description: "New password; prefer --password-stdin" },
          passphrase: { type: "string", stdin: true, description: "New key passphrase; prefer --passphrase-stdin" },
          description: { type: "string", description: "New note; pass an empty string to clear it" },
          category: { type: "string", aliases: ["group"], description: "New category; pass an empty string to clear it" },
        },
        async run({ positionals, options }) {
          const path = await getPath();
          const patch = {
            name: options["new-name"], host: options.host, user: options.user, port: options.port, mode: options.mode,
            keyPath: options["key-path"], password: options.password, passphrase: options.passphrase,
            description: options.description, category: options.category,
          };
          const error = changeServers(path, (state) => updateServer(state, positionals.name, patch));
          if (error !== null) throw new PluginCliError(error, { code: "edit_failed", hint: "Run bb ssh edit --help." });
          const renamed = options["new-name"] !== undefined && options["new-name"] !== positionals.name;
          const moved = renamed ? await moveChats(positionals.name, options["new-name"] ?? positionals.name) : 0;
          return { exitCode: 0, stdout: `Updated ${options["new-name"] ?? positionals.name}.${moved > 0 ? ` Moved ${moved} chat(s) to the new name.` : ""}` };
        },
      }),
      remove: cliCommand({
        summary: "Remove an SSH server from the servers file",
        positionals: [{ name: "name", description: "Server name from bb ssh list", required: true }],
        async run({ positionals }) {
          const path = await getPath();
          const error = changeServers(path, (state) => removeServer(state, positionals.name));
          if (error !== null) throw new PluginCliError(error, { code: "remove_failed", hint: "Run bb ssh list." });
          return { exitCode: 0, stdout: `Removed ${positionals.name} from ${path}.` };
        },
      }),
      category: cliCommand({
        summary: "Move a server into a category, or clear its category",
        positionals: [
          { name: "name", description: "Server name from bb ssh list", required: true },
          { name: "category", description: "Category name; omit with --clear" },
        ],
        options: { clear: { type: "boolean", description: "Remove the server from its category" } },
        async run({ positionals, options }) {
          if (options.clear === (positionals.category !== undefined)) {
            throw new PluginCliError("Pass a category or --clear, not both.", { code: "category_required", hint: "bb ssh category web Production" });
          }
          const path = await getPath();
          const category = options.clear ? null : positionals.category ?? null;
          const error = changeServers(path, (state) => setCategory(state, positionals.name, category));
          if (error !== null) throw new PluginCliError(error, { code: "category_failed", hint: "Run bb ssh list." });
          return { exitCode: 0, stdout: category === null ? `Cleared the category of ${positionals.name}.` : `Moved ${positionals.name} to ${category}.` };
        },
      }),
      "new-category": cliCommand({
        summary: "Create a category, optionally moving servers into it",
        positionals: [{ name: "name", description: "Category name, at most 64 characters", required: true }],
        options: { server: { type: "string", repeatable: true, split: ",", aliases: ["servers"], description: "Server to move into the new category; repeat or comma-separate" } },
        async run({ positionals, options }) {
          const path = await getPath();
          const members = options.server ?? [];
          const error = changeServers(path, (state) => createCategory(state, positionals.name, members));
          if (error !== null) throw new PluginCliError(error, { code: "category_create_failed", hint: "Run bb ssh list." });
          return { exitCode: 0, stdout: `Created ${positionals.name.trim()}${members.length > 0 ? ` with ${members.length} ${members.length === 1 ? "server" : "servers"}` : ""}.` };
        },
      }),
      "delete-category": cliCommand({
        summary: "Delete an empty category",
        positionals: [{ name: "name", description: "Category name", required: true }],
        async run({ positionals }) {
          const path = await getPath();
          const error = changeServers(path, (state) => deleteCategory(state, positionals.name));
          if (error !== null) throw new PluginCliError(error, { code: "category_delete_failed", hint: "Move its servers with bb ssh category <server> --clear first." });
          return { exitCode: 0, stdout: `Deleted ${positionals.name}.` };
        },
      }),
      path: cliCommand({
        summary: "Print the resolved servers file path on the BB server",
        async run() { return { exitCode: 0, stdout: await getPath() }; },
      }),
    },
  });
}
