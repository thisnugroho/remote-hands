Pick a server in the Remote Hands panel in BB and start a dedicated AI chat. Each chat keeps
its server selection in plugin metadata, so the agent's `ssh_exec` tool always
targets that server.

## Server entries

Keep key and password connections in a private JSON file on the BB server.
The default is `~/.ssh/bb-servers.json`, with an optional `serversFile` setting.
The panel shows connection details and descriptions without credentials.

Use `bb ssh list`, `bb ssh path`, and `bb ssh import` to inspect entries and
preview concrete aliases from SSH config. Add `--write` to save imported key
connections without replacing existing names or credentials.

## Commands in chat

The agent uses non-interactive system SSH. Each call supports a command,
optional stdin, and a timeout. The tool reports exit status and bounded stdout
and stderr. Passwords and key passphrases use an askpass environment variable.
OpenSSH ControlMaster reuses connections for ten minutes.

## Requirements

Requires `/usr/bin/ssh` on the BB server and network access to the target.
Keys, SSH-agent access, and credentials belong to the account running BB.
There is no external service or account requirement. New host keys are accepted
and recorded by OpenSSH. Changed host keys are rejected. The agent receives
instructions to confirm destructive or irreversible operations.
