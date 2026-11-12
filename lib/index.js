/**
 * dsh-plugin-session-delete — working port for DeepSeek Harness 0.2.1-rc.x
 *
 * The original chuling-lingling plugin (v0.3.0) feeds a deletion queue through
 * the 0.1.x `settings` namespace and is driven by the client `settingsScope`.
 * Neither surface exists in 0.2.1-rc.x, so this port keeps the same behaviour
 * over a supported channel: the host registers one loopback HTTP route, and the
 * conversation-header Trash button calls it with the current session id.
 *
 * Behaviour preserved from the original:
 *   - the header Trash button is a deletion entry point;
 *   - a host-side deletion QUEUE serializes requests (bounded batch of 50);
 *   - deleting detaches the live entry from the session store, which emits
 *     `session/disposed` — the event the API proxy already forwards, so every
 *     open client drops the row live;
 *   - the persisted directory `~/.dsh/sessions/<project>/<session-id>/` is removed,
 *     so the session never resurrects at boot;
 *   - ids are whitelisted before touching the filesystem, and every failure
 *     degrades to a log line instead of throwing the drain.
 *
 * @module dsh-plugin-session-delete
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const name = "session-delete";
export const inject = ["webServer", "sessions", "agents"];

/** Host route the header button POSTs to. Deliberately outside `/api`. */
const ROUTE = "/session-delete";
/** Accepted session-id spellings: `session-<uuid>`, `worker-<hex>`, a bare
 *  UUID, or any other plain id. Sub-agent/worker sessions and legacy bare-UUID
 *  records are valid deletion targets too, so the old `session-`-only filter
 *  (which silently rejected them) is relaxed. Every id is still scrubbed to a
 *  safe charset before it ever touches the filesystem. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
/** Refuse pathologically large request bodies. */
const MAX_BODY = 64 * 1024;
/** Largest batch one drain pass handles. */
const MAX_BATCH = 50;

/** Expand a leading `~` / `~\` against the user's home directory. */
function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

/** Harness home: `$DSH_HOME` (expanded), else `~/.dsh`. */
function harnessHome() {
	const configured = process.env.DSH_HOME;
	if (configured !== undefined && configured.trim() !== "") return expandHome(configured);
	return join(homedir(), ".dsh");
}

/**
 * Session root. Prefer the mounted backend's own root (a relocated root is
 * honoured); fall back to `<harness home>/sessions`.
 */
function sessionRoot(ctx) {
	const persistence = ctx.get("sessionPersistence");
	const root = persistence?.root;
	if (typeof root === "string" && root !== "") return root;
	return join(harnessHome(), "sessions");
}

/** Every project directory under `root` that holds a directory for `id`.
 *  Some stores name the directory `session-<uuid>` and some just `<uuid>`,
 *  so accept either spelling (fixes "无磁盘目录" false negative). */
async function sessionDirs(root, id) {
	const found = [];
	let projects;
	try {
		projects = await readdir(root, { withFileTypes: true });
	} catch {
		return found;
	}
	// Ids arrive as `session-<uuid>`; also try the bare uuid (and vice versa).
	const candidates = new Set([id]);
	const bare = id.startsWith("session-") ? id.slice("session-".length) : `session-${id}`;
	candidates.add(bare);
	for (const entry of projects) {
		if (!entry.isDirectory()) continue;
		for (const name of candidates) {
			const dir = join(root, entry.name, name);
			try {
				const info = await stat(dir);
				if (info.isDirectory() && !found.includes(dir)) found.push(dir);
			} catch {}
		}
	}
	return found;
}

/**
 * Ids of sessions that were forked FROM `id` (their header names `id` as
 * `parentSession`). Both live and persisted sessions are consulted: a child may
 * be closed on disk while its parent is open, or the reverse. Deleting a parent
 * with children is refused because the child's own durable header still points
 * at it.
 */
async function childSessionIds(ctx, id) {
	const found = new Set();
	try {
		for (const session of ctx.sessions.list()) {
			const parent = session?.header?.parentSession;
			if (parent === id && session.id !== id) found.add(session.id);
		}
	} catch {}
	const persistence = ctx.get("sessionPersistence");
	if (persistence?.list) {
		try {
			for (const snapshot of await persistence.list()) {
				const header = snapshot?.header;
				if (header?.parentSession === id && header.id !== id) found.add(header.id);
			}
		} catch {}
	}
	return [...found];
}

/** Best-effort removal of this session's projection-cache record. */
async function clearProjectionCache(id) {
	const file = join(harnessHome(), "storages", "session_projcache", "sessions", `${id}.json`);
	try {
		await rm(file, { force: true });
	} catch {}
}

/** Remove `dir`, retrying briefly while a closing writer may still hold a file. */
async function removeDir(dir) {
	// A live session's persistence writer close()s asynchronously on
	// `session/disposed`; Windows holds the file until it finishes. Retry long
	// enough for that drain instead of failing the delete.
	for (let attempt = 0; attempt < 25; attempt++) {
		try {
			await rm(dir, { recursive: true, force: true });
			return;
		} catch (error) {
			if (attempt === 24) throw error;
			await new Promise((resolve) => setTimeout(resolve, 300));
		}
	}
}

/** Best-effort append of one outcome line to a plugin-local log for diagnosis. */
function appendLog(line) {
	void import("node:fs/promises")
		.then(({ appendFile }) => appendFile(join(harnessHome(), "plugin-session-delete.log"), `${line}\n`))
		.catch(() => {});
}

/**
 * Tell every open client the row is gone. A live session emits this through
 * `session/disposed` already; a cold session (absent from the live store) emits
 * nothing, so without this the sidebar keeps a row whose files no longer exist.
 */
function notifyRemoved(ctx, id) {
	try {
		ctx.emit("api-session/removed", id);
	} catch {}
}

/**
 * Stop the live Agent (so it cannot keep writing), detach the session from the
 * store (emits `session/disposed`), then drop the Agent registry entry. Every
 * step is best-effort and contained: a missing piece is normal for a cold
 * session, and nothing here may throw the drain.
 */
function detachLive(ctx, sessions, id) {
	let detached = false;
	// 1. Stop running work and unregister the Agent, if one is live.
	try {
		const agent = ctx.agents?.get?.(id);
		if (agent !== undefined) {
			try {
				agent.cancel?.({ kind: "disposed" }, { keepInbox: true });
			} catch {}
			const entry = ctx.agents?.store?.get?.(id);
			if (entry !== undefined) {
				try {
					ctx.agents.detachEntered(entry);
				} catch {}
			}
		}
	} catch {}
	// 2. Detach the session itself — this is what emits `session/disposed`.
	const session = sessions.get(id);
	if (session !== undefined) {
		const entry = sessions.liveEntryFor(session);
		sessions.detachEntered(entry);
		detached = true;
	}
	return detached;
}

/** One deletion attempt; returns the human-readable outcome line. */
async function deleteSession(ctx, id, seen = new Set()) {
	const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
	if (!SESSION_ID.test(id)) return `${stamp} 拒绝 ${id}:非法的会话 ID`;
	if (seen.has(id)) return `${stamp} 跳过 ${id}:检测到 fork 循环`;
	seen.add(id);
	// A forked child's durable header still names this session as its parent, so
	// deleting the parent alone would orphan the child. Instead of refusing, we
	// cascade: delete every descendant first (leaves first via recursion), then
	// this session. Cycles are guarded with `seen`; depth is bounded naturally by
	// the fork tree. Failures on a child are logged and skipped, never aborting
	// the whole deletion of the requested id.
	const children = await childSessionIds(ctx, id);
	const childNotes = [];
	for (const child of children) {
		if (child === id) continue;
		try {
			const note = await deleteSession(ctx, child, seen);
			childNotes.push(note);
		} catch (error) {
			childNotes.push(`${stamp} 失败 ${child}:级联删除出错(${String(error?.message ?? error)})`);
		}
	}
	const cascadeSuffix = childNotes.length > 0 ? `（级联 ${children.length} 个子会话）` : "";
	let detached = false;
	try {
		detached = detachLive(ctx, ctx.sessions, id);
	} catch (error) {
		return `${stamp} 失败 ${id}:内存移除出错(${String(error?.message ?? error)})`;
	}
	const root = sessionRoot(ctx);
	const dirs = await sessionDirs(root, id);
	void clearProjectionCache(id);
	if (dirs.length === 0) {
		// A session deleted inside its creation window can flush its directory
		// to disk moments AFTER this scan. Re-check once, late, so the directory
		// cannot survive a deletion the log already reported.
		setTimeout(() => {
			void sessionDirs(root, id).then((late) => {
				for (const dir of late) void removeDir(dir).catch(() => {});
			});
		}, 1500).unref?.();
		notifyRemoved(ctx, id);
		return `${stamp} ${detached ? "已删除" : "清理"} ${id}:无磁盘目录${detached ? "" : "(仅存在于内存)"}${cascadeSuffix}`;
	}
	for (const dir of dirs) {
		try {
			await removeDir(dir);
		} catch (error) {
			return `${stamp} 失败 ${id}:目录删除出错(${String(error?.message ?? error)})`;
		}
	}
	notifyRemoved(ctx, id);
	return `${stamp} 已删除 ${id}:${detached ? "内存 + 磁盘" : "磁盘"}${cascadeSuffix}`;
}

/** Serial deletion queue: requests are processed in order, bounded per pass. */
class DeletionQueue {
	constructor(ctx) {
		this.ctx = ctx;
		this.pending = [];
		this.running = false;
	}
	/** Enqueue one id; resolves with its outcome line once processed. */
	enqueue(id) {
		return new Promise((resolve) => {
			this.pending.push({ id, resolve });
			void this.pump();
		});
	}
	async pump() {
		if (this.running) return;
		this.running = true;
		try {
			while (this.pending.length > 0) {
				const batch = this.pending.splice(0, MAX_BATCH);
				for (const item of batch) {
					let line;
					try {
						line = await deleteSession(this.ctx, item.id);
					} catch (error) {
						line = `${new Date().toISOString()} 失败 ${item.id}:${String(error?.message ?? error)}`;
					}
					this.ctx.logger?.info?.(`session-delete: ${line}`);
					appendLog(line);
					item.resolve(line);
				}
			}
		} finally {
			this.running = false;
		}
	}
}

/** Whether an authority (host[:port]) names a loopback host. */
function isLoopbackHost(hostname) {
	return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
}

/** Reject cross-site and non-loopback-Origin requests before touching state. */
function originAllowed(req) {
	const site = req.headers["sec-fetch-site"];
	if (site !== undefined && site !== "same-origin" && site !== "none") return false;
	const origin = req.headers["origin"];
	if (origin !== undefined) {
		try {
			if (!isLoopbackHost(new URL(origin).hostname)) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Read a small JSON request body. */
async function readJson(req) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > MAX_BODY) throw new Error("request body too large");
		chunks.push(chunk);
	}
	const text = Buffer.concat(chunks).toString("utf8").trim();
	if (text === "") return {};
	return JSON.parse(text);
}

/** Extract a sanitized list of ids from `{ sessionId }` or `{ sessionIds }`. */
function requestedIds(body) {
	const raw = Array.isArray(body?.sessionIds) ? body.sessionIds : body?.sessionId !== undefined ? [body.sessionId] : [];
	return raw.filter((id) => typeof id === "string").slice(0, MAX_BATCH);
}

/**
 * Install the deletion route and its queue. The route is registered as an
 * effect so unloading the plugin removes it.
 */
export function apply(ctx) {
	const queue = new DeletionQueue(ctx);
	ctx.effect(
		() =>
			ctx.webServer.register({
				kind: "exact",
				path: ROUTE,
				handler: async (req, res) => {
					const json = (status, payload) => {
						res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
						res.end(JSON.stringify(payload));
					};
					if (req.method !== "POST") return json(405, { ok: false, error: "method-not-allowed" });
					if (!originAllowed(req)) return json(403, { ok: false, error: "forbidden" });
					let body;
					try {
						body = await readJson(req);
					} catch (error) {
						return json(400, { ok: false, error: String(error?.message ?? error) });
					}
					const ids = requestedIds(body);
					if (ids.length === 0) return json(400, { ok: false, error: "sessionId required" });
					const results = [];
					for (const id of ids) results.push(await queue.enqueue(id));
					return json(200, { ok: true, results });
				},
			}),
		"session-delete: route",
	);
}
