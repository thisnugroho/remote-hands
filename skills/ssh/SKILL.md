---
name: ssh
description: Operate the remote server selected for an SSH chat through ssh_exec, or list, add, edit, remove, categorize, and import SSH server entries.
---

# SSH servers

`bb ssh list` lists servers. `bb ssh list --json` returns their public fields.
`bb ssh path` prints the servers file path on the BB server.
`bb ssh import` previews concrete aliases from that server's `~/.ssh/config`.
`bb ssh import --write` merges key entries into the servers file with permissions 0600.
Existing names and credentials are preserved. Preview output omits credentials.
Wildcard hosts, Match blocks, and Include files are not imported.

`bb ssh add <name> --host <host> --user <user> [--port 22] [--mode key|password]`
adds one server. Key mode takes `--key-path` and `--passphrase-stdin`.
Password mode needs a password. Pipe it with `--password-stdin` so it stays out
of process arguments, for example `printf '%s' "$PW" | bb ssh add vps --host 192.0.2.10 --user ubuntu --mode password --password-stdin`.
`bb ssh edit <name> [--new-name n] [--host h] [--user u] [--port p] [--mode key|password] [--key-path k] [--password-stdin] [--passphrase-stdin] [--description d] [--category c]`
changes only the options given. An empty string clears `--key-path`,
`--description`, and `--category`. A password or passphrase that is not given
stays as it is. Switching to password mode needs a password. Renaming moves the
chats started on the old name to the new one.
`bb ssh remove <name>` deletes an entry.
Each server can have one optional `category` (at most 64 characters) that groups
it in the Remote Hands panel. `bb ssh add ... --category Production` sets it on creation,
`bb ssh category <name> <category>` moves a server, `bb ssh category <name> --clear`
removes it, and `bb ssh list --category <name>` filters case-insensitively.
Categories persist in the file's top-level `categories` list even when empty.
`bb ssh new-category <name> [--server a,b]` creates one and can move servers in.
`bb ssh delete-category <name>` deletes a category only when it holds no servers. The Remote Hands panel has the same Add server
form and a remove button on each row.

The default servers file is `~/.ssh/bb-servers.json`. The plugin setting
`serversFile` overrides it and expands `~`.

```json
{
  "servers": [
    { "name": "web", "host": "example.com", "user": "root", "mode": "key", "keyPath": "~/.ssh/id_ed25519" },
    { "name": "vps", "host": "192.0.2.10", "port": 2222, "user": "ubuntu", "mode": "password", "password": "your-password" }
  ]
}
```

Names must be unique and use letters, numbers, dots, underscores, or hyphens.
`port` defaults to 22. `description` is optional. `mode` is required.
Key entries can omit `keyPath` to use OpenSSH defaults or an agent. An encrypted
key can set `passphrase`. Keep credential fields in the private servers file.
Do not copy passwords or passphrases into chats, commands, or logs.

Open the Remote Hands panel and choose New chat for a server. In that chat, use
`ssh_exec` for every command on the selected machine. Its parameters are
`command`, optional `stdin` of at most 1 MiB, and `timeoutSeconds` from 1 to
1800, default 120. The selected server comes from thread metadata.

Each call runs in a fresh non-interactive login-directory shell without a TTY.
Use `cd dir && command` to choose a directory. Write files with `cat > path`
and supply the contents through `stdin`. Each output stream keeps its last
64 KiB. Timeout and cancellation terminate the local SSH process.
Confirm before destructive or irreversible operations, including reboots,
firewall changes, recursive deletion, and dropping databases.
