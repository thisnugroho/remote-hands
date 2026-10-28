# Remote Hands for BB

Remote Hands keeps your SSH servers in one private file, groups them by
category, and opens an AI chat bound to one server. The agent in that chat runs
commands on the server through the `ssh_exec` tool, so you can ask it to check,
fix, or deploy anything there.

## Install

```sh
bb plugin install git:https://github.com/thisnugroho/remote-hands.git
```

The plugin id stays `ssh`, so its command is `bb ssh` and its settings live
under `bb plugin config ssh`.

## Servers file

Servers live in `~/.ssh/bb-servers.json` on the BB server. Set `serversFile`
with `bb plugin config ssh set serversFile /absolute/path/servers.json` to use
another path. Keep the file private with mode 0600, because it stores
passwords in plain text. See [the SSH skill](skills/ssh/SKILL.md) for the
format and the tool's limits.

## Commands

```sh
bb ssh path
bb ssh list --json
bb ssh import
bb ssh import --write
bb ssh add <name> --host <host> --user <user> [--port 22] [--mode key|password] [--key-path <path>] [--password-stdin]
bb ssh edit <name> [--new-name <name>] [--host <host>] [--port <port>] [--category <category>] ...
bb ssh remove <name>
bb ssh category <name> <category> | --clear
bb ssh list --category <category>
bb ssh new-category <name> [--server a,b]
bb ssh delete-category <name>
```

## Importing from `~/.ssh/config`

Import reads `~/.ssh/config` on the BB server. It imports concrete Host aliases
with their HostName, User, Port, and first IdentityFile. Earlier values win for
repeated aliases. It ignores wildcard blocks, Match blocks, Include directives,
and ProxyCommand. Missing HostName defaults to the alias. Missing User defaults
to the local account. Existing entries keep their credentials. Preview output
shows public fields, and the write preserves full entries in the private file.

## Security

Commands run through `/usr/bin/ssh`. Passwords and key passphrases reach
OpenSSH through an askpass helper and an environment variable, never through
command arguments. The panel, the CLI, and the agent only ever see public
fields. ControlMaster connections persist for ten minutes.

The plugin uses `StrictHostKeyChecking=accept-new`. OpenSSH records new host
keys and rejects changed keys. Key paths use OpenSSH's tilde expansion. The
askpass helper and the ControlMaster sockets live in a 0700
`/tmp/bb-ssh-<uid>` directory.

## Development

Use Node 22.18 or newer for TypeScript tests.

```sh
npm install --include=dev --ignore-scripts
npm test
npx tsc --noEmit
bb plugin build
```

The tests use temporary files and an isolated HOME for import. They do not
connect to remote servers or write the real SSH configuration. Install and
exercise the panel in BB to verify live navigation and agent integration.
