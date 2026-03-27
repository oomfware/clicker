import {
	createEnvelope,
	DEFAULT_PORT,
	HANDSHAKE_TIMEOUT,
	PROTOCOL_VERSION,
	RECONNECT_INTERVAL,
	WS_CLOSE_HANDSHAKE_REJECTED,
	WS_CLOSE_VERSION_MISMATCH,
	parseRelayToExtensionMessage,
	type ExtensionToRelayMessage,
	type RelayToExtensionMessage,
} from '@oomfware/clicker-protocol';

export interface ConnectionEvents {
	onMessage: (msg: RelayToExtensionMessage) => void;
	onConnect: (connectionId: string) => void;
	onReject: (code: number, reason: string) => void;
	onDisconnect: () => void;
}

export class RelayConnection {
	#ws: WebSocket | null = null;
	#pending: WebSocket | null = null;
	#connectionId: string | null = null;
	#reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	#welcomeTimer: ReturnType<typeof setTimeout> | null = null;
	#stopped = false;
	#welcomed = false;
	#name: string;
	readonly #port: number;
	readonly #events: ConnectionEvents;

	constructor(name: string, events: ConnectionEvents, port = DEFAULT_PORT) {
		this.#name = name;
		this.#port = port;
		this.#events = events;
	}

	get connected(): boolean {
		return this.#welcomed && this.#ws?.readyState === WebSocket.OPEN;
	}

	get connectionId(): string | null {
		return this.#connectionId;
	}

	start(): void {
		this.#stopped = false;
		void this.#connect();
	}

	send(payload: ExtensionToRelayMessage['payload']): void {
		this.#ws?.send(JSON.stringify(createEnvelope(payload)));
	}

	stop(): void {
		this.#stopped = true;
		this.#welcomed = false;
		this.#clearTimers();
		this.#pending?.close();
		this.#pending = null;
		this.#ws?.close();
		this.#ws = null;
		this.#connectionId = null;
	}

	/** updates the name and reconnects to the relay */
	reconnectWithName(name: string): void {
		if (name === this.#name) return;
		this.#name = name;
		this.stop();
		this.#stopped = false;
		void this.#connect();
	}

	async #connect(): Promise<void> {
		this.#clearTimers();
		this.#pending?.close();

		// probe the relay via HTTP first to avoid Chrome logging WebSocket connection errors
		try {
			await fetch(`http://127.0.0.1:${this.#port}/health`, { signal: AbortSignal.timeout(2000) });
		} catch {
			if (!this.#stopped) {
				this.#scheduleReconnect();
			}
			return;
		}

		const ws = new WebSocket(`ws://127.0.0.1:${this.#port}/extension`);
		this.#pending = ws;

		ws.addEventListener('open', () => {
			this.#pending = null;
			this.#ws = ws;
			this.send({ type: 'ext:hello', name: this.#name, protocolVersion: PROTOCOL_VERSION });

			// client-side welcome timeout, slightly longer than server's to avoid races
			this.#welcomeTimer = setTimeout(() => {
				ws.close();
			}, HANDSHAKE_TIMEOUT + 1_000);
		});

		ws.addEventListener('message', (event) => {
			const msg = parseRelayToExtensionMessage(event.data);
			if (!msg) return;

			if (msg.payload.type === 'relay:welcome') {
				if (this.#welcomeTimer) {
					clearTimeout(this.#welcomeTimer);
					this.#welcomeTimer = null;
				}
				this.#welcomed = true;
				this.#connectionId = msg.payload.connectionId;
				this.#events.onConnect(msg.payload.connectionId);
				return;
			}

			if (msg.payload.type === 'ping') {
				this.send({ type: 'pong' });
				return;
			}

			this.#events.onMessage(msg);
		});

		ws.addEventListener('close', (event) => {
			const wasTracked = this.#ws === ws || this.#pending === ws;
			const wasWelcomed = this.#welcomed && this.#ws === ws;

			if (this.#ws === ws) {
				this.#ws = null;
				this.#connectionId = null;
				this.#welcomed = false;
				this.#clearTimers();
			}

			if (this.#pending === ws) {
				this.#pending = null;
			}

			// relay-initiated rejection — don't auto-reconnect
			if (event.code === WS_CLOSE_VERSION_MISMATCH || event.code === WS_CLOSE_HANDSHAKE_REJECTED) {
				this.#events.onReject(event.code, event.reason);
				return;
			}

			if (wasWelcomed) {
				this.#events.onDisconnect();
			}

			// only reconnect for sockets still tracked by this connection;
			// stale close events from stop() are ignored
			if (!this.#stopped && wasTracked) {
				this.#scheduleReconnect();
			}
		});

		ws.addEventListener('error', () => {
			// close fires after this, triggering reconnect
		});
	}

	#scheduleReconnect(): void {
		this.#reconnectTimer = setTimeout(() => {
			void this.#connect();
		}, RECONNECT_INTERVAL);
	}

	#clearTimers(): void {
		if (this.#reconnectTimer) {
			clearTimeout(this.#reconnectTimer);
			this.#reconnectTimer = null;
		}
		if (this.#welcomeTimer) {
			clearTimeout(this.#welcomeTimer);
			this.#welcomeTimer = null;
		}
	}
}
