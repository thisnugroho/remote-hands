export type ServerGroup<T> = { category: string | null; servers: T[] };

export function groupByCategory<T extends { category: string | null }>(servers: readonly T[], declared: readonly string[] = []): ServerGroup<T>[] {
  const groups = new Map<string | null, T[]>(declared.map((category) => [category, []]));
  for (const server of servers) groups.set(server.category, [...(groups.get(server.category) ?? []), server]);
  return [...groups].map(([category, members]) => ({ category, servers: members })).sort((a, b) =>
    a.category === null ? 1 : b.category === null ? -1 : a.category.localeCompare(b.category));
}
