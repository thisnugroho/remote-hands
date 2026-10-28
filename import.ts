import { parseServersFile, type Server } from "./servers.ts";

type HostBlock = { aliases: string[]; values: Map<string, string> };

function configWords(line: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let escaped = false;
  let started = false;
  for (const char of line) {
    if (escaped) { word += char; escaped = false; started = true; }
    else if (char === "\\") { escaped = true; }
    else if (quote !== null) { if (char === quote) quote = null; else word += char; }
    else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (char === "#") break;
    else if (/\s/.test(char) || (char === "=" && words.length === 0)) {
      if (started) { words.push(word); word = ""; started = false; }
    } else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}

export function importSshConfig(content: string, existing: Server[], defaultUser: string): Server[] {
  const blocks: HostBlock[] = [];
  let block: HostBlock | null = null;
  for (const line of content.split(/\r?\n/)) {
    const [directive, ...values] = configWords(line.trim().replace(/^([^\s=]+)\s*=\s*/, "$1 "));
    if (directive === undefined) continue;
    const key = directive.toLowerCase();
    if (key === "host") {
      block = { aliases: values, values: new Map() };
      blocks.push(block);
    } else if (key === "match") block = null;
    else if (block !== null && values[0] !== undefined && !block.values.has(key)) block.values.set(key, values[0]);
  }
  const names = new Set(existing.map(({ name }) => name));
  const rows: object[] = [];
  for (const { aliases } of blocks) {
    for (const name of aliases) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || names.has(name)) continue;
      const values = new Map<string, string>();
      for (const candidate of blocks) {
        if (!candidate.aliases.includes(name)) continue;
        for (const [key, value] of candidate.values) if (!values.has(key)) values.set(key, value);
      }
      const host = (values.get("hostname") ?? name).replaceAll("%h", name);
      const user = values.get("user") ?? defaultUser;
      const keyPath = values.get("identityfile")?.replaceAll("%h", host).replaceAll("%r", user);
      rows.push({ name, host, user, port: Number(values.get("port") ?? 22), mode: "key", ...(keyPath === undefined || keyPath.toLowerCase() === "none" ? {} : { keyPath }) });
      names.add(name);
    }
  }
  const parsed = parseServersFile(JSON.stringify({ servers: rows }), "~/.ssh/config");
  if (!parsed.ok) throw new Error(`SSH config import failed. ${parsed.error}`);
  return [...existing, ...parsed.servers];
}
