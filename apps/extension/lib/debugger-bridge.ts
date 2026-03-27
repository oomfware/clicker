import { REQUEST_TIMEOUT, isRestrictedUrl } from '@oomfware/clicker-protocol';

export interface DebuggerEvents {
	onCdpEvent: (tabId: number, method: string, params?: Record<string, unknown>, sessionId?: string) => void;
	onDetached: (tabId: number, reason: string) => void;
}

interface IframeSession {
	sessionId: string;
	ready: boolean;
}

/** max time to wait for a child session to become ready before sending on it anyway */
const SESSION_READY_TIMEOUT = 2000;
const SESSION_READY_POLL = 50;

/** must fire before the relay's REQUEST_TIMEOUT so the extension can report a useful error */
const CDP_COMMAND_TIMEOUT = REQUEST_TIMEOUT - 5_000;

/**
 * short timeout for Input.dispatchMouseEvent commands.
 * Chromium's InputHandler can strand the response callback, so we treat
 * timeout as assumed-success for mouse events (which return empty `{}`).
 */
const INPUT_ACK_TIMEOUT = 200;

interface PendingCommand {
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	tabId: number;
	sessionId?: string;
}

export class DebuggerBridge {
	#attachedTabs = new Set<number>();
	/** per-tab attach lock to prevent concurrent attach() races */
	#attachingTabs = new Map<number, Promise<void>>();
	/** per-tab iframe session tracking: tabId → (frameId → IframeSession) */
	#iframeSessions = new Map<number, Map<string, IframeSession>>();
	/** in-flight CDP commands, tracked so they can be rejected on detach */
	#pending = new Map<number, PendingCommand>();
	#nextPendingId = 0;
	readonly #events: DebuggerEvents;

	constructor(events: DebuggerEvents) {
		this.#events = events;

		chrome.debugger.onEvent.addListener((source, method, params) => {
			if (source.tabId == null || !this.#attachedTabs.has(source.tabId)) return;

			const tabId = source.tabId;

			// intercept child session lifecycle events
			if (method === 'Target.attachedToTarget') {
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP event params are untyped
				this.#handleAttachedToTarget(tabId, (params ?? {}) as Record<string, unknown>);
				return;
			}
			if (method === 'Target.detachedFromTarget') {
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP event params are untyped
				this.#handleDetachedFromTarget(tabId, (params ?? {}) as Record<string, unknown>);
				return;
			}

			// oxlint-disable-next-line no-unsafe-type-assertion -- chrome.debugger.onEvent types params as object
			this.#events.onCdpEvent(tabId, method, params as Record<string, unknown> | undefined, source.sessionId);
		});

		chrome.debugger.onDetach.addListener((source, reason) => {
			if (source.tabId != null && this.#attachedTabs.has(source.tabId)) {
				this.#attachedTabs.delete(source.tabId);
				this.#iframeSessions.delete(source.tabId);
				this.#rejectPending(
					(p) => p.tabId === source.tabId,
					`debugger detached from tab ${source.tabId}: ${reason}`,
				);
				this.#events.onDetached(source.tabId, reason);
			}
		});
	}

	async attach(tabId: number): Promise<void> {
		if (this.#attachedTabs.has(tabId)) return;

		// if another attach is in progress for this tab, wait for it
		const pending = this.#attachingTabs.get(tabId);
		if (pending) {
			await pending;
			return;
		}

		const doAttach = async () => {
			if (this.#attachedTabs.has(tabId)) return;

			// check if the tab URL is restricted before attempting to attach
			const tab = await chrome.tabs.get(tabId);
			if (tab.url && isRestrictedUrl(tab.url)) {
				throw new Error(`Cannot attach debugger to restricted page: ${tab.url}`);
			}

			await chrome.debugger.attach({ tabId }, '1.3');
			this.#attachedTabs.add(tabId);

			try {
				await Promise.all([
					chrome.debugger.sendCommand({ tabId }, 'Page.enable'),
					chrome.debugger.sendCommand({ tabId }, 'Runtime.enable'),
					chrome.debugger.sendCommand({ tabId }, 'Log.enable'),
					chrome.debugger.sendCommand({ tabId }, 'Target.setAutoAttach', {
						autoAttach: true,
						waitForDebuggerOnStart: false,
						flatten: true,
					}),
				]);
			} catch (err) {
				await this.detach(tabId);
				throw err;
			}
		};

		const promise = doAttach().finally(() => {
			this.#attachingTabs.delete(tabId);
		});
		this.#attachingTabs.set(tabId, promise);
		await promise;
	}

	async detach(tabId: number): Promise<void> {
		if (!this.#attachedTabs.has(tabId)) return;

		this.#attachedTabs.delete(tabId);
		this.#iframeSessions.delete(tabId);
		this.#rejectPending((p) => p.tabId === tabId, `debugger detached from tab ${tabId}`);
		await chrome.debugger.detach({ tabId }).catch(() => {});
	}

	/**
	 * sends a CDP command, routing to the correct session based on frameId.
	 * @param frameId if provided and maps to a known OOPIF session, routes to the child session;
	 *   otherwise routes to the main session (same-process frame or no frame context).
	 */
	async sendCommand(
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
		frameId?: string,
	): Promise<unknown> {
		if (!this.#attachedTabs.has(tabId)) {
			throw new Error(`tab ${tabId} is not attached`);
		}

		if (frameId) {
			let session = this.#getIframeSession(tabId, frameId);
			if (session) {
				if (!session.ready) {
					await this.#waitForSessionReady(tabId, frameId);
					// re-read in case the session detached/re-attached during the wait
					session = this.#getIframeSession(tabId, frameId);
					if (!session) {
						throw new Error(`child session for frame ${frameId} detached during wait`);
					}
				}
				return this.#tracked(
					tabId,
					method,
					session.sessionId,
					chrome.debugger.sendCommand({ tabId, sessionId: session.sessionId }, method, params),
				);
			}
			// no child session → same-process frame, use main session
		}

		return this.#tracked(tabId, method, undefined, chrome.debugger.sendCommand({ tabId }, method, params));
	}

	/**
	 * sends an Input.dispatchMouseEvent command with a short timeout that
	 * resolves on expiry instead of rejecting. immediate errors (detach,
	 * bad target) still propagate.
	 */
	async sendInputCommand(
		tabId: number,
		params?: Record<string, unknown>,
		frameId?: string,
	): Promise<unknown> {
		if (!this.#attachedTabs.has(tabId)) {
			throw new Error(`tab ${tabId} is not attached`);
		}

		const method = 'Input.dispatchMouseEvent';

		if (frameId) {
			let session = this.#getIframeSession(tabId, frameId);
			if (session) {
				if (!session.ready) {
					await this.#waitForSessionReady(tabId, frameId);
					session = this.#getIframeSession(tabId, frameId);
					if (!session) {
						throw new Error(`child session for frame ${frameId} detached during wait`);
					}
				}
				return this.#trackedInput(
					tabId,
					session.sessionId,
					chrome.debugger.sendCommand({ tabId, sessionId: session.sessionId }, method, params),
				);
			}
		}

		return this.#trackedInput(tabId, undefined, chrome.debugger.sendCommand({ tabId }, method, params));
	}

	isAttached(tabId: number): boolean {
		return this.#attachedTabs.has(tabId);
	}

	async attachAll(tabIds: number[]): Promise<void> {
		await Promise.allSettled(tabIds.filter((id) => !this.#attachedTabs.has(id)).map((id) => this.attach(id)));
	}

	async detachAll(tabIds: number[]): Promise<void> {
		await Promise.allSettled(tabIds.map((id) => this.detach(id)));
	}

	// #region command tracking

	/** wraps a CDP command promise with timeout and detach rejection */
	#tracked(
		tabId: number,
		method: string,
		sessionId: string | undefined,
		command: Promise<unknown>,
	): Promise<unknown> {
		const id = this.#nextPendingId++;

		return new Promise<unknown>((resolve, reject) => {
			const settle = () => {
				const entry = this.#pending.get(id);
				if (!entry) return false;
				clearTimeout(entry.timer);
				this.#pending.delete(id);
				return true;
			};

			const timer = setTimeout(() => {
				if (settle()) {
					reject(
						new Error(`CDP ${method} timed out on tab ${tabId}${sessionId ? ` session ${sessionId}` : ''}`),
					);
				}
			}, CDP_COMMAND_TIMEOUT);

			this.#pending.set(id, {
				reject: (err: Error) => {
					if (settle()) reject(err);
				},
				timer,
				tabId,
				sessionId,
			});

			command.then(
				(value) => {
					if (settle()) resolve(value);
				},
				(err) => {
					if (settle()) reject(err);
				},
			);
		});
	}

	/** like #tracked but resolves (instead of rejecting) on timeout — for Input.dispatchMouseEvent */
	#trackedInput(tabId: number, sessionId: string | undefined, command: Promise<unknown>): Promise<unknown> {
		const id = this.#nextPendingId++;

		return new Promise<unknown>((resolve, reject) => {
			const settle = () => {
				const entry = this.#pending.get(id);
				if (!entry) return false;
				clearTimeout(entry.timer);
				this.#pending.delete(id);
				return true;
			};

			const timer = setTimeout(() => {
				if (settle()) resolve(undefined);
			}, INPUT_ACK_TIMEOUT);

			this.#pending.set(id, {
				reject: (err: Error) => {
					if (settle()) reject(err);
				},
				timer,
				tabId,
				sessionId,
			});

			command.then(
				(value) => {
					if (settle()) resolve(value);
				},
				(err) => {
					if (settle()) reject(err);
				},
			);
		});
	}

	#rejectPending(predicate: (p: PendingCommand) => boolean, error: string): void {
		for (const [, pending] of this.#pending) {
			if (predicate(pending)) {
				pending.reject(new Error(error));
			}
		}
	}

	// #endregion

	// #region iframe session management

	/* oxlint-disable no-unsafe-type-assertion -- CDP event params are untyped */
	#handleAttachedToTarget(tabId: number, params: Record<string, unknown>): void {
		const targetInfo = params.targetInfo as Record<string, unknown> | undefined;
		const sessionId = params.sessionId as string | undefined;
		if (!targetInfo || !sessionId) return;

		// only track iframe targets, ignore workers/service workers
		if (targetInfo.type !== 'iframe') return;

		// for OOPIF targets, Chrome uses the targetId as the frameId
		const frameId = targetInfo.targetId as string | undefined;
		if (!frameId) return;

		let tabSessions = this.#iframeSessions.get(tabId);
		if (!tabSessions) {
			tabSessions = new Map();
			this.#iframeSessions.set(tabId, tabSessions);
		}
		tabSessions.set(frameId, { sessionId, ready: false });

		// enable required domains on the child session, then mark ready
		void this.#initChildSession(tabId, sessionId, frameId);
	}
	/* oxlint-enable no-unsafe-type-assertion */

	async #initChildSession(tabId: number, sessionId: string, frameId: string): Promise<void> {
		try {
			await Promise.all([
				chrome.debugger.sendCommand({ tabId, sessionId }, 'DOM.enable'),
				chrome.debugger.sendCommand({ tabId, sessionId }, 'Accessibility.enable'),
			]);
		} catch {
			// child session may have been destroyed before init completed
		}

		const session = this.#getIframeSession(tabId, frameId);
		if (session && session.sessionId === sessionId) {
			session.ready = true;
		}
	}

	#handleDetachedFromTarget(tabId: number, params: Record<string, unknown>): void {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP event params are untyped
		const sessionId = params.sessionId as string | undefined;
		if (!sessionId) return;

		this.#rejectPending(
			(p) => p.sessionId === sessionId,
			`child session ${sessionId} detached from tab ${tabId}`,
		);

		const tabSessions = this.#iframeSessions.get(tabId);
		if (!tabSessions) return;

		// clean up by matching sessionId
		for (const [frameId, session] of tabSessions) {
			if (session.sessionId === sessionId) {
				tabSessions.delete(frameId);
				break;
			}
		}
	}

	#getIframeSession(tabId: number, frameId: string): IframeSession | undefined {
		return this.#iframeSessions.get(tabId)?.get(frameId);
	}

	async #waitForSessionReady(tabId: number, frameId: string): Promise<void> {
		const deadline = Date.now() + SESSION_READY_TIMEOUT;
		while (Date.now() < deadline) {
			const session = this.#getIframeSession(tabId, frameId);
			if (!session || session.ready) return;
			// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
			await new Promise((r) => setTimeout(r, SESSION_READY_POLL));
		}
	}

	// #endregion
}
