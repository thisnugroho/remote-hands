import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const baseFields = {
  name: z.string().regex(/^[A-Za-z0-9._-]+$/, "Use letters, numbers, dots, underscores, or hyphens"),
  host: z.string().regex(/^(?!-)[A-Za-z0-9._:[\]%-]+$/, "Expected an SSH hostname or IP address"),
  port: z.number().int().min(1).max(65535).default(22),
  user: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/, "Expected an SSH username"),
  description: z.string().nullable().optional().transform((value) => value ?? null),
  category: z.string().max(64, "Use at most 64 characters").nullable().optional().transform((value) => value?.trim() || null),
};
const keyRow = z.object({
  ...baseFields,
  mode: z.literal("key"),
  keyPath: z.string().min(1).nullable().optional().transform((value) => value ?? null),
  passphrase: z.string().min(1).nullable().optional().transform((value) => value ?? null),
}).transform(({ mode, keyPath, passphrase, ...server }) => ({
  ...server, auth: { mode, keyPath, passphrase },
}));
const passwordRow = z.object({
  ...baseFields,
  mode: z.literal("password"),
  password: z.string().min(1),
}).transform(({ mode, password, ...server }) => ({ ...server, auth: { mode, password } }));
const rowSchema = z.discriminatedUnion("mode", [keyRow, passwordRow]);

export type Server = z.output<typeof rowSchema>;
export type Auth = Server["auth"];
export type ServersState = { servers: Server[]; categories: string[] };
export type ServersFile = ({ ok: true } & ServersState) | { ok: false; error: string; path: string };

export const publicServerSchema = z.object({
  name: z.string(), host: z.string(), port: z.number(), user: z.string(),
  description: z.string().nullable(), category: z.string().nullable(), mode: z.enum(["key", "password"]),
  keyPath: z.string().nullable().optional(),
});
export type PublicServer = z.output<typeof publicServerSchema>;

export function publicServer(server: Server): PublicServer {
  return publicServerSchema.parse({ ...server, ...server.auth });
}

export function expandHome(path: string, home = homedir()): string {
  return path === "~" ? home : path.startsWith("~/") ? resolve(home, path.slice(2)) : resolve(path);
}

export function parseServersFile(content: string | null, path: string): ServersFile {
  if (content === null) return { ok: true, servers: [], categories: [] };
  let input: unknown;
  try {
    input = JSON.parse(content);
  } catch {
    return { ok: false, error: "Invalid JSON in servers file.", path };
  }
  const envelope = z.object({ servers: z.array(z.unknown()), categories: z.array(z.unknown()).optional() }).safeParse(input);
  if (!envelope.success) return { ok: false, error: 'Expected an object with a "servers" array.', path };
  const servers: Server[] = [];
  const names = new Set<string>();
  for (const [index, row] of envelope.data.servers.entries()) {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.join(".") || "server";
      return { ok: false, error: `Row ${index + 1}, ${field}: ${issue?.message ?? "Invalid server"}.`, path };
    }
    if (names.has(parsed.data.name)) {
      return { ok: false, error: `Row ${index + 1}: duplicate server name. Names must be unique.`, path };
    }
    names.add(parsed.data.name);
    servers.push(parsed.data);
  }
  let categories: string[] = [];
  for (const [index, value] of (envelope.data.categories ?? []).entries()) {
    const parsed = categoryName.safeParse(value);
    if (!parsed.success) return { ok: false, error: `Category ${index + 1}: ${parsed.error.issues[0]?.message ?? "Invalid category"}.`, path };
    categories = declare(categories, parsed.data);
  }
  for (const { category } of servers) if (category !== null) categories = declare(categories, category);
  return { ok: true, servers, categories };
}

export function serializeServers({ servers, categories }: ServersState): string {
  return JSON.stringify({
    ...(categories.length > 0 ? { categories } : {}),
    servers: servers.map(({ auth, ...server }) => ({ ...server, ...auth })),
  }, null, 2) + "\n";
}

export type ServersChange = ({ ok: true } & ServersState) | { ok: false; error: string };

const categoryName = z.string().trim().min(1, "Enter a category name").max(64, "Use at most 64 characters");

function declare(categories: string[], category: string): string[] {
  return categories.includes(category) ? categories : [...categories, category];
}

function sameName(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: "accent" }) === 0;
}

export function addServer({ servers, categories }: ServersState, row: unknown): ServersChange {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "server"}: ${issue?.message ?? "Invalid server"}.` };
  }
  if (servers.some(({ name }) => name === parsed.data.name)) {
    return { ok: false, error: `A server named ${parsed.data.name} already exists.` };
  }
  const { category } = parsed.data;
  return { ok: true, servers: [...servers, parsed.data], categories: category === null ? categories : declare(categories, category) };
}

export function removeServer({ servers, categories }: ServersState, name: string): ServersChange {
  const remaining = servers.filter((server) => server.name !== name);
  return remaining.length === servers.length ? { ok: false, error: `No server named ${name}.` } : { ok: true, servers: remaining, categories };
}

export function setCategory({ servers, categories }: ServersState, name: string, category: string | null): ServersChange {
  const parsed = baseFields.category.safeParse(category);
  if (!parsed.success) return { ok: false, error: `category: ${parsed.error.issues[0]?.message ?? "Invalid category"}.` };
  if (!servers.some((server) => server.name === name)) return { ok: false, error: `No server named ${name}.` };
  const next = parsed.data;
  return {
    ok: true,
    servers: servers.map((server) => (server.name === name ? { ...server, category: next } : server)),
    categories: next === null ? categories : declare(categories, next),
  };
}

export function createCategory({ servers, categories }: ServersState, name: string, members: readonly string[]): ServersChange {
  const parsed = categoryName.safeParse(name);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid category name." };
  const category = parsed.data;
  const existing = categories.find((candidate) => sameName(candidate, category));
  if (existing !== undefined) return { ok: false, error: `A category named ${existing} already exists.` };
  const unknown = members.find((member) => !servers.some((server) => server.name === member));
  if (unknown !== undefined) return { ok: false, error: `No server named ${unknown}.` };
  return {
    ok: true,
    servers: servers.map((server) => (members.includes(server.name) ? { ...server, category } : server)),
    categories: [...categories, category],
  };
}

export function deleteCategory({ servers, categories }: ServersState, name: string): ServersChange {
  if (!categories.includes(name)) return { ok: false, error: `No category named ${name}.` };
  const inside = servers.filter((server) => server.category === name).length;
  if (inside > 0) return { ok: false, error: `Move the ${inside} ${inside === 1 ? "server" : "servers"} out of ${name} before deleting it.` };
  return { ok: true, servers, categories: categories.filter((category) => category !== name) };
}

const secretKeys = ["password", "passphrase"] as const;
const authKeys = ["password", "keyPath", "passphrase"] as const;

export function updateServer({ servers, categories }: ServersState, originalName: string, patch: Record<string, unknown>): ServersChange {
  const index = servers.findIndex((server) => server.name === originalName);
  if (index === -1) return { ok: false, error: `No server named ${originalName}.` };
  const { auth, ...current } = servers[index];
  const row: Record<string, unknown> = { ...current, ...auth };
  if (patch.mode !== undefined && patch.mode !== auth.mode) for (const key of authKeys) delete row[key];
  for (const [key, value] of Object.entries(patch)) {
    const keepSecret = (secretKeys as readonly string[]).includes(key) && (value === undefined || value === "");
    if (value !== undefined && !keepSecret) row[key] = value === "" ? null : value;
  }
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".") || "server"}: ${issue?.message ?? "Invalid server"}.` };
  }
  if (parsed.data.name !== originalName && servers.some(({ name }) => name === parsed.data.name)) {
    return { ok: false, error: `A server named ${parsed.data.name} already exists.` };
  }
  const { category } = parsed.data;
  return {
    ok: true,
    servers: servers.map((server, position) => (position === index ? parsed.data : server)),
    categories: category === null ? categories : declare(categories, category),
  };
}
