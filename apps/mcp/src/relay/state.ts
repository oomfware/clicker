import {
	REQUEST_TIMEOUT,
	type Browser,
	type BrowserStatus,
	type Workspace,
} from '@oomfware/clicker-protocol';

import type { WebSocket } from 'ws';

/** a connected extension (one per browser instance) */
export interface ExtensionConnection {
	connectionId: string;
	ws: WebSocket;
	name: string;
	workspaces: Map<string, Workspace>;
	/** true after the first workspace:sync has been received */
	synced: boolean;
}

/** a connected MCP session (one per agent) */
export interface McpSession {
	sessionId: string;
	ws: WebSocket;
	boundWorkspaceId: string | null;
}

interface PendingCallbacks {
	resolve: (value: unknown) => void;
	reject: (reason: Error) => void;
}

interface PendingMeta {
	extensionConnectionId?: string;
	sessionId?: string;
}

interface PendingEntry extends PendingCallbacks, PendingMeta {
	timer: ReturnType<typeof setTimeout>;
}

const toBrowserStatus = (ext: ExtensionConnection): BrowserStatus => ({
	connectionId: ext.connectionId,
	name: ext.name,
	synced: ext.synced,
	workspaces: Array.from(ext.workspaces.values()),
});

/** relay server state */
export class RelayState {
	readonly #extensions = new Map<string, ExtensionConnection>();
	readonly #sessions = new Map<string, McpSession>();
	readonly #workspaceToExtension = new Map<string, string>();
	readonly #workspaceToSessions = new Map<string, Set<string>>();
	readonly #pending = new Map<string, PendingEntry>();
	#connectionChangeListener?: (hasConnections: boolean) => void;

	/** registers a listener that fires whenever the set of MCP sessions changes */
	onSessionChange(listener: (hasSessions: boolean) => void): void {
		this.#connectionChangeListener = listener;
	}

	#notifySessionChange(): void {
		this.#connectionChangeListener?.(this.#sessions.size > 0);
	}

	// #region extensions

	addExtension(conn: ExtensionConnection): void {
		this.#extensions.set(conn.connectionId, conn);
	}

	removeExtension(connectionId: string): void {
		const ext = this.#extensions.get(connectionId);
		if (!ext) return;

		for (const workspaceId of ext.workspaces.keys()) {
			this.#detachWorkspace(workspaceId);
		}

		// reject only pending requests that were waiting on this extension
		for (const [id, pending] of this.#pending) {
			if (pending.extensionConnectionId === connectionId) {
				clearTimeout(pending.timer);
				pending.reject(new Error('extension disconnected'));
				this.#pending.delete(id);
			}
		}

		this.#extensions.delete(connectionId);
	}

	/** finds an extension by connectionId */
	findExtension(connectionId: string): ExtensionConnection | undefined {
		return this.#extensions.get(connectionId);
	}

	/** checks if any connected extension (other than excludeId) uses this name */
	hasName(name: string, excludeConnectionId?: string): boolean {
		for (const ext of this.#extensions.values()) {
			if (ext.name === name && ext.connectionId !== excludeConnectionId) return true;
		}
		return false;
	}

	// #endregion

	// #region sessions

	addSession(session: McpSession): void {
		this.#sessions.set(session.sessionId, session);
		this.#notifySessionChange();
	}

	removeSession(sessionId: string): void {
		const session = this.#sessions.get(sessionId);
		if (session?.boundWorkspaceId) {
			const set = this.#workspaceToSessions.get(session.boundWorkspaceId);
			if (set) {
				set.delete(sessionId);
				if (set.size === 0) {
					this.#workspaceToSessions.delete(session.boundWorkspaceId);
				}
			}
		}
		this.#sessions.delete(sessionId);

		// reject any in-flight requests that were initiated by this session
		for (const [id, pending] of this.#pending) {
			if (pending.sessionId === sessionId) {
				clearTimeout(pending.timer);
				pending.reject(new Error('session disconnected'));
				this.#pending.delete(id);
			}
		}

		this.#notifySessionChange();
	}

	bindSession(sessionId: string, workspaceId: string): void {
		const session = this.#sessions.get(sessionId);
		if (!session) return;

		if (session.boundWorkspaceId) {
			const set = this.#workspaceToSessions.get(session.boundWorkspaceId);
			if (set) {
				set.delete(sessionId);
				if (set.size === 0) {
					this.#workspaceToSessions.delete(session.boundWorkspaceId);
				}
			}
		}

		session.boundWorkspaceId = workspaceId;

		let sessions = this.#workspaceToSessions.get(workspaceId);
		if (!sessions) {
			sessions = new Set();
			this.#workspaceToSessions.set(workspaceId, sessions);
		}
		sessions.add(sessionId);
	}

	/** gets all sessions bound to a workspace */
	getSessionsForWorkspace(workspaceId: string): McpSession[] {
		const sessionIds = this.#workspaceToSessions.get(workspaceId);
		if (!sessionIds) return [];

		const sessions: McpSession[] = [];
		for (const id of sessionIds) {
			const session = this.#sessions.get(id);
			if (session) {
				sessions.push(session);
			}
		}
		return sessions;
	}

	// #endregion

	// #region workspaces

	registerWorkspace(workspaceId: string, connectionId: string, workspace: Workspace): void {
		const ext = this.#extensions.get(connectionId);
		if (!ext) return;

		ext.workspaces.set(workspaceId, workspace);
		this.#workspaceToExtension.set(workspaceId, connectionId);
	}

	/**
	 * replaces an extension's workspace set with a fresh snapshot.
	 * @returns removed workspaces and the sessions that were bound to them,
	 *          so the caller can forward synthetic workspace:destroyed events.
	 */
	syncExtensionWorkspaces(
		connectionId: string,
		workspaces: Workspace[],
	): Array<{ workspaceId: string; sessions: McpSession[] }> {
		const ext = this.#extensions.get(connectionId);
		if (!ext) return [];

		const newWorkspaceIds = new Set(workspaces.map((ws) => ws.id));

		// find workspaces that disappeared and collect affected sessions
		const removed: Array<{ workspaceId: string; sessions: McpSession[] }> = [];
		for (const oldId of ext.workspaces.keys()) {
			if (!newWorkspaceIds.has(oldId)) {
				const sessions = this.#detachWorkspace(oldId);
				removed.push({ workspaceId: oldId, sessions });
			}
		}

		// install new snapshot
		ext.workspaces.clear();
		for (const ws of workspaces) {
			ext.workspaces.set(ws.id, ws);
			this.#workspaceToExtension.set(ws.id, connectionId);
		}

		// restore session subscriptions for sessions still bound to surviving workspaces
		for (const session of this.#sessions.values()) {
			if (session.boundWorkspaceId && newWorkspaceIds.has(session.boundWorkspaceId)) {
				let sessions = this.#workspaceToSessions.get(session.boundWorkspaceId);
				if (!sessions) {
					sessions = new Set();
					this.#workspaceToSessions.set(session.boundWorkspaceId, sessions);
				}
				sessions.add(session.sessionId);
			}
		}

		return removed;
	}

	/** removes a single workspace from tracking and unbinds any sessions */
	removeWorkspace(workspaceId: string): void {
		const connId = this.#workspaceToExtension.get(workspaceId);
		if (!connId) return;

		const ext = this.#extensions.get(connId);
		if (ext) {
			ext.workspaces.delete(workspaceId);
		}

		this.#detachWorkspace(workspaceId);
	}

	/**
	 * returns cached workspaces for an extension.
	 * @returns workspace list, or null if the extension hasn't synced yet.
	 */
	listWorkspacesForExtension(connectionId: string): Workspace[] | null {
		const ext = this.#extensions.get(connectionId);
		if (!ext) return null;
		if (!ext.synced) return null;
		return Array.from(ext.workspaces.values());
	}

	/** unbinds sessions, removes workspace from lookup maps, returns affected sessions */
	#detachWorkspace(workspaceId: string): McpSession[] {
		const sessions = this.getSessionsForWorkspace(workspaceId);
		for (const session of sessions) {
			session.boundWorkspaceId = null;
		}
		this.#workspaceToExtension.delete(workspaceId);
		this.#workspaceToSessions.delete(workspaceId);
		return sessions;
	}

	getExtensionForWorkspace(workspaceId: string): ExtensionConnection | undefined {
		const connId = this.#workspaceToExtension.get(workspaceId);
		if (!connId) return undefined;
		return this.#extensions.get(connId);
	}

	listBrowsers(): Browser[] {
		return Array.from(this.#extensions.values(), (ext) => ({
			connectionId: ext.connectionId,
			name: ext.name,
			workspaceCount: ext.workspaces.size,
		}));
	}

	/** returns full browser -> workspace -> tab tree for status queries */
	listBrowserStatuses(connectionId?: string): BrowserStatus[] {
		if (connectionId) {
			const ext = this.#extensions.get(connectionId);
			if (!ext) return [];
			return [toBrowserStatus(ext)];
		}

		return Array.from(this.#extensions.values(), toBrowserStatus);
	}

	// #endregion

	// #region pending requests

	addPending(id: string, callbacks: PendingCallbacks, meta: PendingMeta = {}): void {
		const timer = setTimeout(() => {
			this.#pending.delete(id);
			callbacks.reject(new Error('clicker request timed out waiting for the extension to respond'));
		}, REQUEST_TIMEOUT);

		this.#pending.set(id, { ...callbacks, timer, ...meta });
	}

	/** peeks at the session that initiated a pending request (before resolvePending deletes it) */
	getPendingSessionId(id: string): string | undefined {
		return this.#pending.get(id)?.sessionId;
	}

	resolvePending(id: string, value: unknown): boolean {
		const pending = this.#pending.get(id);
		if (!pending) return false;

		clearTimeout(pending.timer);
		this.#pending.delete(id);
		pending.resolve(value);
		return true;
	}

	// #endregion
}
