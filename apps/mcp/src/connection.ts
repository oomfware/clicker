import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

import {
	createEnvelope,
	createSessionId,
	DEFAULT_PORT,
	HANDSHAKE_TIMEOUT,
	PROTOCOL_VERSION,
	RELAY_STARTUP_TIMEOUT,
	REQUEST_TIMEOUT,
	WS_CLOSE_HANDSHAKE_REJECTED,
	WS_CLOSE_VERSION_MISMATCH,
	parseRelayToSessionMessage,
	type RelayToSessionMessage,
	type SessionToRelayMessage,
} from '@oomfware/clicker-protocol';

import WebSocket from 'ws';

class VersionMismatchError extends Error {}

/** one-line summary of an outbound request used in timeout error messages */
const describeRequest = (payload: SessionToRelayMessage['payload']): string => {
	if (payload.type === 'cdp:command') {
		const parts = [`cdp:command method=${payload.method}`];
		if (payload.tabId !== undefined) parts.push(`tab=${payload.tabId}`);
		if (payload.frameId) parts.push(`frame=${payload.frameId}`);
		return parts.join(' ');
	}
	return payload.type;
};

interface PendingRequest {
	resolve: (value: RelayToSessionMessage) => void;
	reject: (reason: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface RelayEvents {
	'cdp:event': [
		workspaceId: string,
		tabId: number,
		method: string,
		params?: Record<string, unknown>,
		sessionId?: string,
	];
	'tab:adopted': [workspaceId: string, tabId: number, url: string, title: string];
	'tab:removed': [workspaceId: string, tabId: number];
	'tab:active-changed': [workspaceId: string, tabId: number];
	'workspace:destroyed': [workspaceId: string];
}

/** manages a WebSocket connection to the relay server from the MCP server side */
export class RelayConnection extends EventEmitter<RelayEvents> {
	readonly sessionId = createSessionId();
	readonly #port: number;
	#ws: WebSocket | null = null;
	#connected = false;
	#pending = new Map<string, PendingRequest>();

	constructor(port = Number(process.env.CLICKER_PORT) || DEFAULT_PORT) {
		super();
		this.#port = port;
	}

	async connect(): Promise<void> {
		const alive = await this.#checkRelay();
		if (!alive) {
			this.#spawnRelay();
			await this.#waitForRelay();
		}

		try {
			await this.#openSocket();
		} catch (err) {
			// stale relay from a previous version — shut it down, respawn, and retry once
			if (err instanceof VersionMismatchError) {
				await this.#shutdownRelay();
				this.#spawnRelay();
				await this.#waitForRelay();
				await this.#openSocket();
				return;
			}
			throw err;
		}
	}

	async request(payload: SessionToRelayMessage['payload']): Promise<RelayToSessionMessage> {
		if (!this.#ws) throw new Error('Not connected to relay');

		const ws = this.#ws;
		const full = createEnvelope(payload);

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(full.id);
				reject(
					new Error(
						`clicker request timed out waiting for the extension to respond (${describeRequest(payload)}, ${REQUEST_TIMEOUT}ms)`,
					),
				);
			}, REQUEST_TIMEOUT);

			this.#pending.set(full.id, { resolve, reject, timer });
			ws.send(JSON.stringify(full));
		});
	}

	send(payload: SessionToRelayMessage['payload']): void {
		this.#ws?.send(JSON.stringify(createEnvelope(payload)));
	}

	close(): void {
		this.#ws?.close();
		this.#ws = null;
		this.#connected = false;
	}

	get connected(): boolean {
		return this.#connected;
	}

	async #checkRelay(): Promise<boolean> {
		try {
			const res = await fetch(`http://127.0.0.1:${this.#port}/health`);
			return res.ok;
		} catch {
			return false;
		}
	}

	#spawnRelay(): void {
		const child = spawn(process.execPath, [process.argv[1], 'relay', 'start', '--idle-timeout', '2'], {
			detached: true,
			stdio: 'ignore',
			env: { ...process.env, CLICKER_PORT: String(this.#port) },
		});
		child.unref();
	}

	async #waitForRelay(): Promise<void> {
		const deadline = Date.now() + RELAY_STARTUP_TIMEOUT;
		while (Date.now() < deadline) {
			// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
			if (await this.#checkRelay()) {
				return;
			}

			// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
			await new Promise((r) => setTimeout(r, 200));
		}
		throw new Error(`relay did not start within ${RELAY_STARTUP_TIMEOUT}ms`);
	}

	async #shutdownRelay(): Promise<void> {
		try {
			await fetch(`http://127.0.0.1:${this.#port}/shutdown`, { method: 'POST' });
			// give it a moment to exit
			await new Promise((r) => setTimeout(r, 200));
		} catch {
			// relay may already be gone
		}
	}

	async #openSocket(): Promise<void> {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(`ws://127.0.0.1:${this.#port}/session`);
			let settled = false;

			const rejectOnce = (err: Error) => {
				if (settled) return;
				settled = true;
				reject(err);
			};

			const resolveOnce = () => {
				if (settled) return;
				settled = true;
				resolve();
			};

			let welcomeTimer: ReturnType<typeof setTimeout> | null = null;

			ws.on('open', () => {
				this.#ws = ws;
				this.send({ type: 'session:hello', sessionId: this.sessionId, protocolVersion: PROTOCOL_VERSION });

				welcomeTimer = setTimeout(() => {
					ws.close();
					rejectOnce(new Error('timed out waiting for session welcome'));
				}, HANDSHAKE_TIMEOUT + 1_000);
			});

			ws.on('message', (data) => {
				const msg = parseRelayToSessionMessage(data);
				if (!msg) return;

				if (msg.payload.type === 'session:welcome') {
					if (welcomeTimer) {
						clearTimeout(welcomeTimer);
						welcomeTimer = null;
					}
					this.#connected = true;
					resolveOnce();
					return;
				}

				if (msg.payload.type === 'ping') {
					this.send({ type: 'pong' });
					return;
				}

				// CDP events — emit for listeners (wait_for, handle_dialog, etc.)
				if (msg.payload.type === 'cdp:event') {
					this.emit(
						'cdp:event',
						msg.payload.workspaceId,
						msg.payload.tabId,
						msg.payload.method,
						msg.payload.params,
						msg.payload.sessionId,
					);
					return;
				}

				if (msg.payload.type === 'tab:adopted') {
					this.emit(
						'tab:adopted',
						msg.payload.workspaceId,
						msg.payload.tabId,
						msg.payload.url,
						msg.payload.title,
					);
					return;
				}

				if (msg.payload.type === 'tab:removed') {
					this.emit('tab:removed', msg.payload.workspaceId, msg.payload.tabId);
					return;
				}

				if (msg.payload.type === 'tab:active-changed') {
					this.emit('tab:active-changed', msg.payload.workspaceId, msg.payload.tabId);
					return;
				}

				// unsolicited workspace destruction (user closed/renamed group)
				if (msg.payload.type === 'workspace:destroyed' && !msg.payload.replyTo) {
					this.emit('workspace:destroyed', msg.payload.workspaceId);
					return;
				}

				// responses — match by replyTo
				if ('replyTo' in msg.payload && typeof msg.payload.replyTo === 'string') {
					const { replyTo } = msg.payload;
					const pending = this.#pending.get(replyTo);
					if (pending) {
						clearTimeout(pending.timer);
						this.#pending.delete(replyTo);
						pending.resolve(msg);
					}
				}
			});

			ws.on('error', (err) => {
				if (!this.#connected) {
					rejectOnce(err);
				}
			});

			ws.on('close', (code, reason) => {
				if (welcomeTimer) {
					clearTimeout(welcomeTimer);
					welcomeTimer = null;
				}
				this.#connected = false;
				this.#ws = null;
				for (const pending of this.#pending.values()) {
					clearTimeout(pending.timer);
					pending.reject(new Error('connection closed'));
				}
				this.#pending.clear();
				if (!settled) {
					if (code === WS_CLOSE_VERSION_MISMATCH) {
						rejectOnce(new VersionMismatchError(reason.toString()));
					} else if (code === WS_CLOSE_HANDSHAKE_REJECTED) {
						rejectOnce(new Error(`handshake rejected: ${reason.toString()}`));
					} else {
						rejectOnce(new Error('connection closed before session was established'));
					}
				}
			});
		});
	}
}
