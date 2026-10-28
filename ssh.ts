import type { Server } from "./servers.ts";

export function sshInvocation(server: Server, controlDir: string, askpassPath: string): {
  args: string[]; env: Record<string, string>;
} {
  const args = [
    "-T", "-p", String(server.port),
    "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=30",
    "-o", "StrictHostKeyChecking=accept-new", "-o", "ControlMaster=auto",
    "-o", "ControlPersist=10m", "-o", `ControlPath=${controlDir}/%C`,
  ];
  let secret: string | null;
  switch (server.auth.mode) {
    case "password":
      args.push("-o", "PreferredAuthentications=password,keyboard-interactive", "-o", "PubkeyAuthentication=no", "-o", "NumberOfPasswordPrompts=1");
      secret = server.auth.password;
      break;
    case "key":
      if (server.auth.keyPath !== null) args.push("-o", "IdentitiesOnly=yes", "-i", server.auth.keyPath);
      secret = server.auth.passphrase;
      if (secret === null) args.push("-o", "BatchMode=yes");
      break;
  }
  args.push(`${server.user}@${server.host}`);
  const env: Record<string, string> = secret === null ? {} : {
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: ":0",
    BB_SSH_SECRET: secret,
  };
  return { args, env };
}
