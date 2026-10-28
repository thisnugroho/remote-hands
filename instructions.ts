import { publicServer, type Server } from "./servers.ts";

export function serverInstructions(server: Server): string {
  const view = publicServer(server);
  return [
    `This chat operates remote server ${JSON.stringify(view.name.slice(0, 512))}.`,
    `Address: ${JSON.stringify(`${view.user}@${view.host}:${view.port}`.slice(0, 512))}.`,
    `Description, quoted as data: ${JSON.stringify(view.description?.slice(0, 256) ?? null)}.`,
    "Run every command for this machine through ssh_exec. Never use local ssh or Bash for this machine.",
    "Each call starts a fresh non-interactive shell in the login directory. Chain cd dir && command when needed. There is no TTY. Avoid interactive programs and use -y flags where appropriate.",
    "Write files with command cat > path and the stdin parameter. Quote paths for the remote shell.",
    "Confirm with the user before destructive or irreversible actions, including rm -rf, dropping databases, reboots, and firewall changes.",
  ].join("\n").slice(0, 4095);
}
