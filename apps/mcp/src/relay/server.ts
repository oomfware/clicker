import { createServer, type IncomingMessage } from 'node:http';

import {
	createConnectionId,
	createEnvelope,
	DEFAULT_PORT,
	HANDSHAKE_TIMEOUT,
	PING_INTERVAL,
	PROTOCOL_VERSION,
	WS_CLOSE_HANDSHAKE_REJECTED,
	WS_CLOSE_HEARTBEAT_TIMEOUT,
	WS_CLOSE_VERSION_MISMATCH,
	parseExtensionToRelayMessage,
	parseSessionToRelayMessage,
	type ExtensionToRelayMessage,
	type RelayToExtensionMessage,
	type RelayToSessionMessage,
} from '@oomfware/clicker-protocol';

import { WebSocketServer, type WebSocket } from 'ws';

import { RelayState, type ExtensionConnection } from './state.ts';

/** close connections that miss 3 consecutive pongs */
const MISSED_PONG_LIMIT = 3;

/**
 * starts a ping/pong heartbeat for a WebSocket connection.
 * closes the socket with WS_CLOSE_HEARTBEAT_TIMEOUT after MISSED_PONG_LIMIT missed pongs.
 * @returns an object to record pongs and clean up the interval
 */
const startHeartbeat = (ws: WebSocket, send: () => void) => {
	let missedPongs = 0;
	const interval = setInterval(() => {
		missedPongs++;
		if (missedPongs >= MISSED_PONG_LIMIT) {
			clearInterval(interval);
			ws.close(WS_CLOSE_HEARTBEAT_TIMEOUT, 'heartbeat_timeout');
			return;
		}
		send();
	}, PING_INTERVAL);
	return {
		receivedPong: () => {
			missedPongs = 0;
		},
		stop: () => clearInterval(interval),
	};
};

/** wraps a payload in the message envelope and sends it, returns the message id */
const sendMessage = (
	ws: WebSocket,
	payload: RelayToExtensionMessage['payload'] | RelayToSessionMessage['payload'],
): string => {
	const msg = createEnvelope(payload);
	ws.send(JSON.stringify(msg));
	return msg.id;
};

/** forwards an already-enveloped message as raw JSON */
const forward = (ws: WebSocket, msg: { id: string; ts: number; payload: unknown }): void => {
	ws.send(JSON.stringify(msg));
};

export interface RelayHandle {
	close: () => void;
	/** registers a listener that fires whenever the set of MCP sessions changes */
	onSessionChange: (listener: (hasSessions: boolean) => void) => void;
}

/** sends a request to an extension and registers pending callbacks for the response */
const proxyToExtension = (
	state: RelayState,
	ext: ExtensionConnection,
	outbound: RelayToExtensionMessage['payload'],
	resolve: (response: ExtensionToRelayMessage) => void,
	reject: (err: Error) => void,
	sessionId?: string,
): void => {
	const requestId = sendMessage(ext.ws, outbound);
	state.addPending(
		requestId,
		{
			resolve: (raw) => {
				// oxlint-disable-next-line no-unsafe-type-assertion -- protocol-guaranteed response shape
				resolve(raw as ExtensionToRelayMessage);
			},
			reject,
		},
		{ extensionConnectionId: ext.connectionId, sessionId },
	);
};

/** creates and starts the relay server */
export const startRelay = (port = DEFAULT_PORT): RelayHandle => {
	const state = new RelayState();

	const server = createServer((req, res) => {
		if (req.url === '/health') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
			return;
		}

		if (req.url === '/status') {
			const browsers = state.listBrowsers();
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ extensions: browsers.length, browsers }));
			return;
		}

		if (req.url === '/shutdown' && req.method === 'POST') {
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ ok: true }));
			// close after response is sent
			setTimeout(() => {
				wss.close();
				server.close();
				process.exit(0);
			}, 50);
			return;
		}

		res.writeHead(404);
		res.end();
	});

	const wss = new WebSocketServer({ noServer: true });

	server.on('upgrade', (req: IncomingMessage, socket, head) => {
		const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

		if (url.pathname === '/extension' || url.pathname === '/session') {
			wss.handleUpgrade(req, socket, head, (ws) => {
				wss.emit('connection', ws, req, url.pathname);
			});
		} else {
			socket.destroy();
		}
	});

	wss.on('connection', (ws: WebSocket, _req: IncomingMessage, path: string) => {
		if (path === '/extension') {
			handleExtension(ws, state);
		} else if (path === '/session') {
			handleSession(ws, state);
		}
	});

	server.listen(port, () => {
		console.log(`relay listening on port ${port}`);
	});

	return {
		close: () => {
			wss.close();
			server.close();
		},
		onSessionChange: (listener) => {
			state.onSessionChange(listener);
		},
	};
};

// #region extension handler

const handleExtension = (ws: WebSocket, state: RelayState): void => {
	let connectionId: string | null = null;
	let handshakeComplete = false;
	let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

	const handshakeTimer = setTimeout(() => {
		ws.close(WS_CLOSE_HANDSHAKE_REJECTED, 'handshake_timeout');
	}, HANDSHAKE_TIMEOUT);

	ws.on('message', (data) => {
		const msg = parseExtensionToRelayMessage(data);
		if (!msg) return;

		// ignore non-hello messages before handshake, ignore duplicate hellos after
		if (!handshakeComplete && msg.payload.type !== 'ext:hello') return;
		if (handshakeComplete && msg.payload.type === 'ext:hello') return;

		switch (msg.payload.type) {
			case 'ext:hello': {
				clearTimeout(handshakeTimer);

				if (msg.payload.protocolVersion !== PROTOCOL_VERSION) {
					ws.close(
						WS_CLOSE_VERSION_MISMATCH,
						`expected version ${PROTOCOL_VERSION}, got ${msg.payload.protocolVersion}`,
					);
					break;
				}

				if (state.hasName(msg.payload.name)) {
					ws.close(WS_CLOSE_HANDSHAKE_REJECTED, 'name_conflict');
					break;
				}

				connectionId = createConnectionId();
				handshakeComplete = true;
				state.addExtension({
					connectionId,
					ws,
					name: msg.payload.name,
					workspaces: new Map(),
					synced: false,
				});
				sendMessage(ws, { type: 'relay:welcome', connectionId, protocolVersion: PROTOCOL_VERSION });
				console.log(`extension connected: ${msg.payload.name} → ${connectionId}`);

				heartbeat = startHeartbeat(ws, () => sendMessage(ws, { type: 'ping' }));
				break;
			}

			case 'workspace:created': {
				if (!connectionId) break;
				if (msg.payload.replyTo) {
					// command response — always process
					if (msg.payload.result.ok) {
						state.registerWorkspace(
							msg.payload.result.workspace.id,
							connectionId,
							msg.payload.result.workspace,
						);
					}
					state.resolvePending(msg.payload.replyTo, msg);
				} else {
					// unsolicited (user created tab group) — guard pre-sync
					const ext = state.findExtension(connectionId);
					if (!ext?.synced) break;
					if (msg.payload.result.ok) {
						state.registerWorkspace(
							msg.payload.result.workspace.id,
							connectionId,
							msg.payload.result.workspace,
						);
					}
				}
				break;
			}

			case 'workspace:destroyed': {
				if (!connectionId) break;
				if (msg.payload.replyTo) {
					// sessions must be notified before removeWorkspace clears the workspace-to-session mappings
					if (msg.payload.result.ok) {
						const requesterId = state.getPendingSessionId(msg.payload.replyTo);
						for (const session of state.getSessionsForWorkspace(msg.payload.workspaceId)) {
							if (session.sessionId === requesterId) continue;
							sendMessage(session.ws, {
								type: 'workspace:destroyed',
								workspaceId: msg.payload.workspaceId,
								result: { ok: true },
							});
						}
						state.removeWorkspace(msg.payload.workspaceId);
					}
					state.resolvePending(msg.payload.replyTo, msg);
				} else {
					// unsolicited (user closed/renamed group) — guard pre-sync
					const ext = state.findExtension(connectionId);
					if (!ext?.synced) break;
					if (msg.payload.result.ok) {
						for (const session of state.getSessionsForWorkspace(msg.payload.workspaceId)) {
							forward(session.ws, msg);
						}
						state.removeWorkspace(msg.payload.workspaceId);
					}
				}
				break;
			}

			case 'workspace:sync': {
				if (!connectionId) break;
				const ext = state.findExtension(connectionId);
				if (!ext) break;
				const removed = state.syncExtensionWorkspaces(connectionId, msg.payload.workspaces);
				ext.synced = true;
				// forward synthetic workspace:destroyed for workspaces that disappeared
				for (const { workspaceId, sessions } of removed) {
					for (const session of sessions) {
						sendMessage(session.ws, {
							type: 'workspace:destroyed',
							workspaceId,
							result: { ok: true },
						});
					}
				}
				break;
			}

			// topology events below are forwarding-only — relay state comes from workspace:sync

			case 'workspace:updated':
			case 'tab:updated': {
				// metadata-only; state updated via next workspace:sync
				break;
			}

			case 'tab:active-changed':
			case 'cdp:event':
			case 'tab:adopted':
			case 'tab:removed': {
				if (!connectionId) break;
				const ext = state.findExtension(connectionId);
				if (!ext?.synced) break;
				for (const session of state.getSessionsForWorkspace(msg.payload.workspaceId)) {
					forward(session.ws, msg);
				}
				break;
			}

			case 'cdp:result': {
				state.resolvePending(msg.payload.replyTo, msg);
				break;
			}

			case 'tab:created':
			case 'tab:closed':
			case 'tab:activated': {
				// command responses — state updated via next workspace:sync
				state.resolvePending(msg.payload.replyTo, msg);
				break;
			}

			case 'pong':
				heartbeat?.receivedPong();
				break;
		}
	});

	ws.on('close', () => {
		clearTimeout(handshakeTimer);
		heartbeat?.stop();
		if (connectionId) {
			console.log(`extension disconnected: ${connectionId}`);
			// sessions must be notified before removeExtension clears the workspace-to-session mappings
			const ext = state.findExtension(connectionId);
			if (ext) {
				for (const workspaceId of ext.workspaces.keys()) {
					for (const session of state.getSessionsForWorkspace(workspaceId)) {
						sendMessage(session.ws, {
							type: 'workspace:destroyed',
							workspaceId,
							result: { ok: true },
						});
					}
				}
			}
			state.removeExtension(connectionId);
		}
	});
};

// #endregion

// #region session handler

/**
 * proxies a session request to an extension and forwards the response back.
 * replaces the relay-internal replyTo with the session's original message id.
 *
 * @param makeError builds the error response payload for transport-level failures
 *   (timeout, disconnected). must match the response type the caller expects.
 */
const proxyRequest = (
	state: RelayState,
	sessionWs: WebSocket,
	sessionId: string,
	msgId: string,
	ext: ExtensionConnection,
	outbound: RelayToExtensionMessage['payload'],
	makeError: (replyTo: string, error: string) => RelayToSessionMessage['payload'],
	onResponse?: (response: ExtensionToRelayMessage) => void,
): void => {
	proxyToExtension(
		state,
		ext,
		outbound,
		(response) => {
			onResponse?.(response);
			// replace the relay-internal replyTo so the session's pending request resolves
			forward(sessionWs, {
				...response,
				payload: { ...response.payload, replyTo: msgId },
			});
		},
		(err) => {
			sendMessage(sessionWs, makeError(msgId, err.message));
		},
		sessionId,
	);
};

const WORKSPACE_NOT_FOUND = 'Workspace not found.';
const browserNotFound = (id: string) =>
	`No browser found for "${id}". Run status to see available connections.`;

const handleSession = (ws: WebSocket, state: RelayState): void => {
	let sessionId: string | null = null;
	let handshakeComplete = false;
	let heartbeat: ReturnType<typeof startHeartbeat> | null = null;

	const handshakeTimer = setTimeout(() => {
		ws.close(WS_CLOSE_HANDSHAKE_REJECTED, 'handshake_timeout');
	}, HANDSHAKE_TIMEOUT);

	ws.on('message', (data) => {
		const msg = parseSessionToRelayMessage(data);
		if (!msg) return;

		if (!handshakeComplete && msg.payload.type !== 'session:hello') return;
		if (handshakeComplete && msg.payload.type === 'session:hello') return;

		switch (msg.payload.type) {
			case 'session:hello': {
				clearTimeout(handshakeTimer);

				if (msg.payload.protocolVersion !== PROTOCOL_VERSION) {
					ws.close(
						WS_CLOSE_VERSION_MISMATCH,
						`expected version ${PROTOCOL_VERSION}, got ${msg.payload.protocolVersion}`,
					);
					break;
				}

				sessionId = msg.payload.sessionId;
				handshakeComplete = true;
				state.addSession({ sessionId, ws, boundWorkspaceId: null });
				sendMessage(ws, { type: 'session:welcome', sessionId, protocolVersion: PROTOCOL_VERSION });
				console.log(`session connected: ${sessionId}`);

				heartbeat = startHeartbeat(ws, () => sendMessage(ws, { type: 'ping' }));
				break;
			}

			case 'workspace:list': {
				const workspaces = state.listWorkspacesForExtension(msg.payload.connectionId);
				if (workspaces === null) {
					const ext = state.findExtension(msg.payload.connectionId);
					sendMessage(ws, {
						type: 'workspace:state',
						replyTo: msg.id,
						result: {
							ok: false,
							error: ext ? 'browser connected but not yet synced' : browserNotFound(msg.payload.connectionId),
						},
					});
					break;
				}
				sendMessage(ws, {
					type: 'workspace:state',
					replyTo: msg.id,
					result: { ok: true, workspaces },
				});
				break;
			}

			case 'status:query': {
				sendMessage(ws, {
					type: 'status:result',
					replyTo: msg.id,
					browsers: state.listBrowserStatuses(msg.payload.connectionId),
				});
				break;
			}

			case 'workspace:bind': {
				if (!sessionId) break;
				const { workspaceId: bindWorkspaceId } = msg.payload;
				const sid = sessionId;
				const bindExt = state.getExtensionForWorkspace(bindWorkspaceId);
				const bindWorkspace = bindExt?.workspaces.get(bindWorkspaceId);
				if (!bindExt || !bindWorkspace) {
					sendMessage(ws, {
						type: 'workspace:bound',
						replyTo: msg.id,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}

				const completeBind = () => {
					// revalidate — workspace may have been removed while waiting for tab:create
					if (!state.getExtensionForWorkspace(bindWorkspaceId)) {
						sendMessage(ws, {
							type: 'workspace:bound',
							replyTo: msg.id,
							result: { ok: false, error: WORKSPACE_NOT_FOUND },
						});
						return;
					}
					const otherSessions = state
						.getSessionsForWorkspace(bindWorkspaceId)
						.filter((s) => s.sessionId !== sid).length;
					state.bindSession(sid, bindWorkspaceId);
					console.log(`session ${sid} bound to workspace ${bindWorkspaceId}`);
					sendMessage(ws, {
						type: 'workspace:bound',
						replyTo: msg.id,
						result: {
							ok: true,
							connectionId: bindExt.connectionId,
							workspace: bindWorkspace,
							otherSessions,
						},
					});
				};

				if (bindWorkspace.tabs.length === 0) {
					// empty workspace — open a blank tab before handing it to the session
					proxyToExtension(
						state,
						bindExt,
						{ type: 'tab:create', workspaceId: bindWorkspaceId, url: 'about:blank', active: true },
						(response) => {
							if (response.payload.type === 'tab:created' && response.payload.result.ok) {
								bindWorkspace.tabs.push(response.payload.result.tab);
							}
							completeBind();
						},
						(err) => {
							console.warn(`failed to create blank tab for empty workspace ${bindWorkspaceId}:`, err.message);
							completeBind();
						},
						sid,
					);
				} else {
					completeBind();
				}
				break;
			}

			case 'workspace:create': {
				const ext = state.findExtension(msg.payload.connectionId);
				if (!ext) {
					sendMessage(ws, {
						type: 'workspace:created',
						replyTo: msg.id,
						result: { ok: false, error: browserNotFound(msg.payload.connectionId) },
					});
					break;
				}

				proxyRequest(
					state,
					ws,
					sessionId!,
					msg.id,
					ext,
					{ type: 'workspace:create', title: msg.payload.title },
					(replyTo, error) => ({
						type: 'workspace:created',
						replyTo,
						result: { ok: false, error },
					}),
					(response) => {
						if (response.payload.type === 'workspace:created' && response.payload.result.ok && sessionId) {
							state.bindSession(sessionId, response.payload.result.workspace.id);
						}
					},
				);
				break;
			}

			case 'workspace:destroy': {
				const { workspaceId } = msg.payload;
				const ext = state.getExtensionForWorkspace(workspaceId);
				if (!ext) {
					sendMessage(ws, {
						type: 'workspace:destroyed',
						replyTo: msg.id,
						workspaceId,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}
				proxyRequest(
					state,
					ws,
					sessionId!,
					msg.id,
					ext,
					{ type: 'workspace:destroy', workspaceId },
					(replyTo, error) => ({
						type: 'workspace:destroyed',
						replyTo,
						workspaceId,
						result: { ok: false, error },
					}),
				);
				break;
			}

			case 'tab:create': {
				const { workspaceId } = msg.payload;
				const ext = state.getExtensionForWorkspace(workspaceId);
				if (!ext) {
					sendMessage(ws, {
						type: 'tab:created',
						replyTo: msg.id,
						workspaceId,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}
				proxyRequest(
					state,
					ws,
					sessionId!,
					msg.id,
					ext,
					{ type: 'tab:create', workspaceId, url: msg.payload.url, active: msg.payload.active },
					(replyTo, error) => ({
						type: 'tab:created',
						replyTo,
						workspaceId,
						result: { ok: false, error },
					}),
				);
				break;
			}

			case 'tab:activate': {
				const { workspaceId, tabId } = msg.payload;
				const ext = state.getExtensionForWorkspace(workspaceId);
				if (!ext) {
					sendMessage(ws, {
						type: 'tab:activated',
						replyTo: msg.id,
						workspaceId,
						tabId,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}
				proxyRequest(
					state,
					ws,
					sessionId!,
					msg.id,
					ext,
					{ type: 'tab:activate', workspaceId, tabId },
					(replyTo, error) => ({
						type: 'tab:activated',
						replyTo,
						workspaceId,
						tabId,
						result: { ok: false, error },
					}),
				);
				break;
			}

			case 'tab:close': {
				const { workspaceId, tabId } = msg.payload;
				const ext = state.getExtensionForWorkspace(workspaceId);
				if (!ext) {
					sendMessage(ws, {
						type: 'tab:closed',
						replyTo: msg.id,
						workspaceId,
						tabId,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}
				proxyRequest(
					state,
					ws,
					sessionId!,
					msg.id,
					ext,
					{ type: 'tab:close', workspaceId, tabId },
					(replyTo, error) => ({
						type: 'tab:closed',
						replyTo,
						workspaceId,
						tabId,
						result: { ok: false, error },
					}),
				);
				break;
			}

			case 'cdp:command': {
				const ext = state.getExtensionForWorkspace(msg.payload.workspaceId);
				if (!ext) {
					sendMessage(ws, {
						type: 'cdp:result',
						replyTo: msg.id,
						result: { ok: false, error: WORKSPACE_NOT_FOUND },
					});
					break;
				}
				proxyRequest(state, ws, sessionId!, msg.id, ext, msg.payload, (replyTo, error) => ({
					type: 'cdp:result',
					replyTo,
					result: { ok: false, error },
				}));
				break;
			}

			case 'pong':
				heartbeat?.receivedPong();
				break;
		}
	});

	ws.on('close', () => {
		clearTimeout(handshakeTimer);
		heartbeat?.stop();
		if (sessionId) {
			console.log(`session disconnected: ${sessionId}`);
			state.removeSession(sessionId);
		}
	});
};

// #endregion
