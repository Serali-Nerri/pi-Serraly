import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { getAgentDir, SessionManager, type ExtensionContext, type SessionInfo } from "@earendil-works/pi-coding-agent";

// Do not retain the host discovery API's allMessagesText transcript cache.
export type CatalogueSession = Pick<SessionInfo, "id" | "path" | "name" | "firstMessage" | "cwd" | "modified">;

function metadata(info: SessionInfo): CatalogueSession {
	return { id: info.id, path: info.path, name: info.name, firstMessage: info.firstMessage, cwd: info.cwd, modified: info.modified };
}

export async function listCatalogue(ctx: ExtensionContext, signal: AbortSignal, agentDir?: string): Promise<CatalogueSession[]> {
	const dir = ctx.sessionManager.getSessionDir();
	// The documented host-managed layout supplies the SDK's effective agent boundary.
	// An arbitrary custom flat directory is never widened to its parent.
	const managed = dir && basename(dirname(dir)) === "sessions" && /^--.*--$/.test(basename(dir));
	if (dir && !managed) return (await SessionManager.listAll(dir, undefined, signal)).map(metadata);
	const collection = managed ? dirname(dir) : join(resolve(agentDir ?? getAgentDir()), "sessions");
	if (collection === join(resolve(getAgentDir()), "sessions")) {
		return (await SessionManager.listAll(undefined, undefined, signal)).map(metadata);
	}
	// Pi 1.0.2's explicit listAll(directory) overload is flat. Enumerate only collection
	// directories, while leaving every session's discovery and format handling to Pi.
	const sessions: CatalogueSession[] = [];
	let directories;
	try { directories = await readdir(collection, { withFileTypes: true }); }
	catch { signal.throwIfAborted(); return []; }
	for (const directory of directories) {
		signal.throwIfAborted();
		if (directory.isDirectory() || directory.isSymbolicLink()) {
			sessions.push(...(await SessionManager.listAll(join(collection, directory.name), undefined, signal)).map(metadata));
		}
	}
	return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
}
