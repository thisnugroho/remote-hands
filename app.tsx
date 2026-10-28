import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { PublicServer } from "./servers";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { groupByCategory, type ServerGroup } from "./groups";
import { cn } from "./lib/utils";

const example = JSON.stringify({ servers: [
  { name: "my-server", host: "example.com", user: "root", mode: "key", keyPath: "~/.ssh/id_ed25519", category: "Production" },
  { name: "password-server", host: "192.0.2.10", port: 2222, user: "ubuntu", mode: "password", password: "your-password" },
] }, null, 2);

const field = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary";

type Draft = { name: string; host: string; port: string; user: string; mode: "key" | "password"; password: string; keyPath: string; passphrase: string; description: string; category: string };
const emptyDraft: Draft = { name: "", host: "", port: "22", user: "root", mode: "password", password: "", keyPath: "", passphrase: "", description: "", category: "" };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="flex flex-col gap-1 text-xs text-muted-foreground">{label}{children}</label>;
}

function CategoryOptions({ id, categories }: { id: string; categories: string[] }) {
  return <datalist id={id}>{categories.map((category) => <option key={category} value={category} />)}</datalist>;
}

function draftFrom(server: PublicServer): Draft {
  return {
    name: server.name, host: server.host, port: String(server.port), user: server.user, mode: server.mode,
    password: "", keyPath: server.keyPath ?? "", passphrase: "", description: server.description ?? "", category: server.category ?? "",
  };
}

function ServerForm({ categories, initial, editing, save, cancel, className }: {
  categories: string[]; initial: Draft; editing: PublicServer | null; save: (draft: Draft) => Promise<string | null>; cancel: () => void; className?: string;
}) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const keepsPassword = editing?.mode === "password";
  const renaming = editing !== null && draft.name.trim() !== editing.name;
  const set = (key: keyof Draft) => (event: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, [key]: event.target.value });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(await save(draft));
    setSaving(false);
  };
  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancel(); } }}
      className={cn("mt-4 grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-2", className)}
      aria-label={editing ? `Edit ${editing.name}` : "Add server"}
    >
      <Field label="Name"><input className={field} required value={draft.name} onChange={set("name")} placeholder="my-server" autoFocus /></Field>
      <Field label="Host"><input className={field} required value={draft.host} onChange={set("host")} placeholder="example.com or 192.0.2.10" /></Field>
      <Field label="User"><input className={field} required value={draft.user} onChange={set("user")} /></Field>
      <Field label="Port"><input className={field} required type="number" min={1} max={65535} value={draft.port} onChange={set("port")} /></Field>
      <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:col-span-2">
        Authentication
        <div className="flex gap-2" role="radiogroup">
          {(["password", "key"] as const).map((mode) => (
            <Button key={mode} type="button" size="sm" variant={draft.mode === mode ? "default" : "ghost"} className={draft.mode === mode ? undefined : "border border-border text-muted-foreground"} role="radio" aria-checked={draft.mode === mode} onClick={() => setDraft({ ...draft, mode })}>
              {mode === "password" ? "Password" : "Public key"}
            </Button>
          ))}
        </div>
      </div>
      {draft.mode === "password" ? (
        <Field label="Password">
          <input className={field} required={keepsPassword === false} type="password" autoComplete="new-password" value={draft.password} onChange={set("password")}
            placeholder={keepsPassword ? "Leave blank to keep the current password" : undefined} />
        </Field>
      ) : (
        <>
          <Field label="Key path (empty = ssh default keys)"><input className={field} value={draft.keyPath} onChange={set("keyPath")} placeholder="~/.ssh/id_ed25519" /></Field>
          <Field label="Key passphrase (optional)">
            <input className={field} type="password" autoComplete="new-password" value={draft.passphrase} onChange={set("passphrase")}
              placeholder={editing?.mode === "key" ? "Leave blank to keep the current one" : undefined} />
          </Field>
        </>
      )}
      <Field label="Category (optional)">
        <input className={field} list="ssh-add-categories" maxLength={64} value={draft.category} onChange={set("category")} placeholder="Production" />
        <CategoryOptions id="ssh-add-categories" categories={categories} />
      </Field>
      <Field label="Description (optional)"><input className={field} value={draft.description} onChange={set("description")} placeholder="Main web server" /></Field>
      {renaming && <p className="text-xs text-muted-foreground sm:col-span-2">Chats started on {editing.name} will move to the new name.</p>}
      {error && <p role="alert" className="text-sm text-destructive sm:col-span-2">{error}</p>}
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving}>{saving ? "Saving…" : editing ? "Save changes" : "Save server"}</Button>
      </div>
    </form>
  );
}

function toRow(draft: Draft) {
  const optional = (key: "keyPath" | "passphrase" | "description" | "category") => (draft[key].trim() === "" ? {} : { [key]: draft[key].trim() });
  return {
    name: draft.name.trim(), host: draft.host.trim(), user: draft.user.trim(), port: Number(draft.port), mode: draft.mode,
    ...(draft.mode === "password" ? { password: draft.password } : { ...optional("keyPath"), ...optional("passphrase") }),
    ...optional("description"), ...optional("category"),
  };
}

function toPatch(draft: Draft) {
  const cleared = (value: string) => (value.trim() === "" ? null : value.trim());
  return {
    name: draft.name.trim(), host: draft.host.trim(), user: draft.user.trim(), port: Number(draft.port), mode: draft.mode,
    ...(draft.password === "" ? {} : { password: draft.password }),
    ...(draft.mode === "key" ? { keyPath: cleared(draft.keyPath) } : {}),
    ...(draft.passphrase === "" ? {} : { passphrase: draft.passphrase }),
    description: cleared(draft.description), category: cleared(draft.category),
  };
}

function CategoryEditor({ server, categories, save, close }: { server: PublicServer; categories: string[]; save: (category: string | null) => Promise<void>; close: () => void }) {
  const [value, setValue] = useState(server.category ?? "");
  const listId = `ssh-category-${server.name}`;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    await save(value.trim() === "" ? null : value.trim());
    close();
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="flex w-full items-center gap-2 sm:w-auto" aria-label={`Category for ${server.name}`}>
      <input className={`${field} sm:w-44`} list={listId} maxLength={64} value={value} onChange={(event) => setValue(event.target.value)} placeholder="No category" autoFocus aria-label="Category" />
      <CategoryOptions id={listId} categories={categories} />
      <Button type="submit" size="sm">Save</Button>
      <Button type="button" size="sm" variant="ghost" onClick={close}>Cancel</Button>
    </form>
  );
}

function ServerRow({ server, categories, pending, start, remove, saveCategory, update }: {
  server: PublicServer; categories: string[]; pending: boolean; start: () => void; remove: () => void;
  saveCategory: (category: string | null) => Promise<void>; update: (draft: Draft) => Promise<string | null>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [categorizing, setCategorizing] = useState(false);
  const [editing, setEditing] = useState(false);
  if (editing) {
    const save = async (draft: Draft) => {
      const error = await update(draft);
      if (error === null) setEditing(false);
      return error;
    };
    return (
      <li className="py-3">
        <ServerForm categories={categories} initial={draftFrom(server)} editing={server} save={save} cancel={() => setEditing(false)} className="mt-0 border-primary/50 bg-background" />
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-center gap-3 py-4">
      <Icon name="Terminal" className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="break-all text-sm font-medium">{server.name}</span>
          <span className="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground">{server.mode}</span>
        </div>
        <p className="break-all font-mono text-xs text-muted-foreground">{server.user}@{server.host}:{server.port}</p>
        {server.description && <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">{server.description}</p>}
      </div>
      <Button size="sm" variant="ghost" onClick={() => { setCategorizing(false); setEditing(true); }} aria-label={`Edit ${server.name}`}>
        <Icon name="Pencil" fallback="Edit" className="size-4" />
        Edit
      </Button>
      {categorizing ? (
        <CategoryEditor server={server} categories={categories} save={saveCategory} close={() => setCategorizing(false)} />
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setCategorizing(true)} aria-label={`Change category of ${server.name}`}>
          <Icon name="Folder" className="size-4" />
          Category
        </Button>
      )}
      <Button size="sm" variant="outline" disabled={pending} onClick={start} aria-label={`New chat on ${server.name}`}>
        New chat
      </Button>
      {confirming ? (
        <>
          <Button size="sm" variant="destructive" onClick={remove} aria-label={`Confirm remove ${server.name}`}>Remove</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
        </>
      ) : (
        <Button size="icon" variant="ghost" onClick={() => setConfirming(true)} aria-label={`Remove ${server.name}`}>
          <Icon name="Trash2" className="size-4" />
        </Button>
      )}
    </li>
  );
}

const groupKey = (category: string | null) => category ?? "";

function CategoryTile({ group, selected, select, open }: { group: ServerGroup<PublicServer>; selected: boolean; select: () => void; open: () => void }) {
  const label = group.category ?? "Uncategorized";
  const total = group.servers.length;
  const keys = group.servers.filter(({ mode }) => mode === "key").length;
  const preview = group.servers.slice(0, 3);
  const modes = ([[keys, "key"], [total - keys, "password"]] as const).filter(([count]) => count > 0).map(([count, mode]) => `${count} ${mode}`).join(" · ");
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-category-key={groupKey(group.category)}
        aria-pressed={selected}
        aria-label={`${label}, ${total} ${total === 1 ? "server" : "servers"}. Double-click or press Enter to open.`}
        onClick={select}
        onDoubleClick={open}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); open(); } }}
        className={cn(
          "flex h-full w-full touch-manipulation select-none flex-col gap-4 rounded-lg border bg-card p-4 text-left outline-none transition-colors duration-150 hover:bg-state-hover hover:duration-0 focus-visible:ring-2 focus-visible:ring-primary/60",
          selected ? "border-primary ring-1 ring-primary" : "border-border",
        )}
      >
        <span className="flex items-start justify-between gap-2">
          <Icon name={selected ? "FolderOpen" : "Folder"} fallback="Folder" className={cn("size-6", selected ? "text-primary" : "text-muted-foreground")} />
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{total}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className={cn("truncate text-sm font-semibold", group.category === null && "text-muted-foreground")}>{label}</span>
          <span className="text-xs tabular-nums text-muted-foreground">{modes || "Empty"}</span>
        </span>
        <span className="flex min-w-0 flex-col gap-0.5 border-t border-border pt-3 font-mono text-xs text-muted-foreground">
          {total === 0 && <span className="font-sans">No servers yet</span>}
          {preview.map(({ name }) => <span key={name} className="truncate">{name}</span>)}
          {total > preview.length && <span className="font-sans">+{total - preview.length} more</span>}
        </span>
      </button>
    </li>
  );
}

function NewCategoryTile({ active, open }: { active: boolean; open: () => void }) {
  return (
    <li className="min-w-0">
      <button
        type="button"
        aria-expanded={active}
        onClick={open}
        className={cn(
          "flex h-full min-h-36 w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-sm text-muted-foreground outline-none transition-colors duration-150 hover:border-foreground/40 hover:bg-state-hover hover:text-foreground hover:duration-0 focus-visible:ring-2 focus-visible:ring-primary/60",
          active ? "border-primary text-foreground" : "border-border",
        )}
      >
        <Icon name="FolderPlus" fallback="Plus" className="size-6" />
        <span className="font-medium">New category</span>
      </button>
    </li>
  );
}

function NewCategoryForm({ servers, create, cancel }: { servers: PublicServer[]; create: (name: string, members: string[]) => Promise<string | null>; cancel: () => void }) {
  const [name, setName] = useState("");
  const [members, setMembers] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const toggle = (server: string) => setMembers((current) => {
    const next = new Set(current);
    if (!next.delete(server)) next.add(server);
    return next;
  });
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(await create(name, servers.filter((server) => members.has(server.name)).map((server) => server.name)));
    setSaving(false);
  };
  return (
    <form onSubmit={(event) => void submit(event)} onKeyDown={(event) => { if (event.key === "Escape") cancel(); }} className="mt-5 flex flex-col gap-4 rounded-lg border border-border bg-card p-4" aria-label="New category">
      <Field label="Category name">
        <input className={cn(field, "sm:max-w-sm")} required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="Production" autoFocus />
      </Field>
      {servers.length > 0 && (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-xs text-muted-foreground">
            Move servers into it <span className="tabular-nums">({members.size} selected)</span>
          </legend>
          <div className="grid max-h-64 gap-x-4 overflow-y-auto rounded-md border border-border p-1 @xl:grid-cols-2">
            {servers.map((server) => (
              <label key={server.name} className="flex min-w-0 cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-sm hover:bg-state-hover">
                <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={members.has(server.name)} onChange={() => toggle(server.name)} />
                <span className="truncate font-mono text-xs">{server.name}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-muted-foreground">{server.category ?? "Uncategorized"}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
        <Button type="submit" size="sm" disabled={saving || name.trim() === ""}>{saving ? "Creating…" : "Create category"}</Button>
      </div>
    </form>
  );
}

function EmptyCategory({ name, addServer, remove }: { name: string; addServer: () => void; remove: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="mt-5 flex flex-col items-start gap-3 rounded-lg border border-dashed border-border p-6">
      <p className="text-sm">No servers in {name} yet.</p>
      <p className="text-sm text-muted-foreground">Add a new server here, or open another category and use Category on a server to move it in.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={addServer}>
          <Icon name="Plus" className="size-4" />
          Add server
        </Button>
        {confirming ? (
          <>
            <Button size="sm" variant="destructive" onClick={remove}>Delete {name}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Keep</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => setConfirming(true)}>
            <Icon name="Trash2" className="size-4" />
            Delete category
          </Button>
        )}
      </div>
    </div>
  );
}

type View = { kind: "categories" } | { kind: "category"; key: string };

function SshPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [data, setData] = useState<{ path: string; servers: PublicServer[]; categories: string[]; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<View>({ kind: "categories" });
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const groups = groupByCategory(data?.servers ?? [], data?.categories ?? []);
  const categories = groups.flatMap(({ category }) => (category === null ? [] : [category]));
  const current = view.kind === "category" ? groups.find(({ category }) => groupKey(category) === view.key) : undefined;
  const openCategory = (key: string) => {
    setSelected(key);
    setAdding(false);
    setCreating(false);
    setNotice(null);
    setView({ kind: "category", key });
  };
  const backToCategories = () => {
    const key = view.kind === "category" ? view.key : null;
    setAdding(false);
    setNotice(null);
    setView({ kind: "categories" });
    requestAnimationFrame(() => {
      if (key !== null) document.querySelector<HTMLElement>(`[data-category-key="${CSS.escape(key)}"]`)?.focus();
    });
  };
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { setData(await rpc.call("listServers")); setError(null); }
    catch { setError("Could not load SSH servers. Try Refresh."); }
    finally { setRefreshing(false); }
  }, [rpc]);
  useEffect(() => { void refresh(); }, [refresh]);
  const start = async (name: string) => {
    setStarting(name);
    try {
      const { threadId } = await rpc.call("startChat", { name });
      navigate.toThread(threadId);
    } catch { setError("Could not start the chat. Refresh the server list and try again."); }
    finally { setStarting(null); }
  };
  const save = async (draft: Draft) => {
    try {
      const { error: saveError } = await rpc.call("addServer", toRow(draft));
      if (saveError !== null) return saveError;
      setAdding(false);
      await refresh();
      return null;
    } catch { return "Could not save the server. Check the fields and try again."; }
  };
  const remove = async (name: string) => {
    try {
      const { error: removeError } = await rpc.call("removeServer", { name });
      setError(removeError);
      if (removeError === null) await refresh();
    } catch { setError("Could not remove the server. Try Refresh."); }
  };
  const saveCategory = async (name: string, category: string | null) => {
    try {
      const { error: categoryError } = await rpc.call("setCategory", { name, category });
      setError(categoryError);
      if (categoryError === null) await refresh();
    } catch { setError("Could not change the category. Try Refresh."); }
  };
  const update = async (originalName: string, draft: Draft) => {
    try {
      const result = await rpc.call("updateServer", { originalName, server: toPatch(draft) });
      if (result.error !== null) return result.error;
      setNotice(result.movedChats > 0 ? `Saved. ${result.movedChats} ${result.movedChats === 1 ? "chat" : "chats"} moved to ${draft.name.trim()}.` : `Saved ${draft.name.trim()}.`);
      await refresh();
      return null;
    } catch { return "Could not save the changes. Check the fields and try again."; }
  };
  const create = async (name: string, members: string[]) => {
    try {
      const result = await rpc.call("createCategory", { name, servers: members });
      if (result.error !== null || result.category === null) return result.error ?? "Could not create the category.";
      await refresh();
      openCategory(result.category);
      return null;
    } catch { return "Could not create the category. Try again."; }
  };
  const removeCategory = async (name: string) => {
    try {
      const { error: deleteError } = await rpc.call("deleteCategory", { name });
      setError(deleteError);
      if (deleteError === null) {
        setSelected(null);
        setView({ kind: "categories" });
        await refresh();
      }
    } catch { setError("Could not delete the category. Try Refresh."); }
  };
  const title = current ? current.category ?? "Uncategorized" : "Remote Hands";
  return (
    <div
      className="h-full min-h-0 flex-1 overflow-y-auto selection:bg-primary/25"
      onKeyDown={(event) => {
        if (event.key === "Escape" && current && !(event.target instanceof HTMLInputElement)) backToCategories();
      }}
    >
      <div className="@container mx-auto box-border w-full max-w-5xl px-4 pb-8 pt-4 md:px-6">
        {current && (
          <Button variant="ghost" size="sm" className="-ml-2 mb-1 text-muted-foreground" onClick={backToCategories}>
            <Icon name="ChevronLeft" className="size-4" />
            Categories
          </Button>
        )}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              {current && <Icon name="FolderOpen" fallback="Folder" className="size-5 text-muted-foreground" />}
              <span className="truncate">{title}</span>
              {current && <span className="text-sm font-normal tabular-nums text-muted-foreground">{current.servers.length}</span>}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {!current ? "Double-click a category to see its servers." : current.servers.length === 0 ? "This category is empty." : "Start a chat to work on one of these servers."}
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" size="sm" disabled={refreshing} onClick={() => void refresh()}>
              <Icon name="RotateCcw" className="size-4" />
              Refresh
            </Button>
            <Button size="sm" disabled={adding || data?.error != null} onClick={() => { setCreating(false); setAdding(true); }}>
              <Icon name="Plus" className="size-4" />
              Add server
            </Button>
          </div>
        </div>
        {adding && <ServerForm categories={categories} initial={{ ...emptyDraft, category: current?.category ?? "" }} editing={null} save={save} cancel={() => setAdding(false)} />}
        {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
        {creating && !current && data && <NewCategoryForm servers={data.servers} create={create} cancel={() => setCreating(false)} />}
        {(error || data?.error) && <p role="alert" className="mt-3 whitespace-pre-wrap break-words text-sm text-destructive">{error || data?.error}</p>}
        {data === null ? (
          <p role="status" className="mt-6 text-sm text-muted-foreground">{error ? "Server list unavailable." : "Loading servers…"}</p>
        ) : current && current.servers.length === 0 && current.category !== null ? (
          <EmptyCategory name={current.category} addServer={() => setAdding(true)} remove={() => void removeCategory(current.category ?? "")} />
        ) : current ? (
          <ul
            key={view.kind === "category" ? view.key : ""}
            aria-label={`Servers in ${title}`}
            className="mt-5 divide-y divide-border rounded-lg border border-border bg-card px-4 transition-[opacity,translate] duration-200 ease-out starting:translate-y-1 starting:opacity-0 motion-reduce:transition-none"
          >
            {current.servers.map((server) => (
              <ServerRow key={server.name} server={server} categories={categories} pending={starting !== null}
                start={() => void start(server.name)} remove={() => void remove(server.name)} saveCategory={(next) => saveCategory(server.name, next)} update={(draft) => update(server.name, draft)} />
            ))}
          </ul>
        ) : groups.length > 0 ? (
          <>
            <ul aria-label="Server categories" className="mt-5 grid grid-cols-1 gap-3 @xs:grid-cols-2 @2xl:grid-cols-4">
              {groups.map((group) => {
                const key = groupKey(group.category);
                return <CategoryTile key={key} group={group} selected={selected === key} select={() => setSelected(key)} open={() => openCategory(key)} />;
              })}
              {data.error === null && <NewCategoryTile active={creating} open={() => { setAdding(false); setCreating(true); }} />}
            </ul>
            <p className="mt-6 break-all font-mono text-xs text-muted-foreground">{data.path}</p>
          </>
        ) : data.error === null ? (
          <div className="mt-5 rounded-lg border border-dashed border-border p-4">
            <h2 className="text-sm font-medium">Add your first server</h2>
            <p className="mt-2 text-sm text-muted-foreground">Use Add server above, save a servers file at <code className="break-all">{data.path}</code>, or preview an import with <code>bb ssh import</code>.</p>
            <pre className="mt-4 overflow-x-auto rounded-md bg-muted p-3 text-xs">{example}</pre>
            <p className="mt-3 text-xs text-muted-foreground">Keep this file private with permissions 0600. Use <code>bb ssh import --write</code> to save imported key entries.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "servers", title: "Remote Hands", icon: "Terminal", path: "servers", component: SshPanel });
});
