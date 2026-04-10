import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { RelayConnection } from '../connection.ts';
import type { ResourceTiming } from '../session.ts';
import { SessionState } from '../session.ts';
import { registerDiscoveryTools } from '../tools/discovery.ts';
import { registerInteractionTools } from '../tools/interaction.ts';
import { registerNavigationTools } from '../tools/navigation.ts';
import { registerNetworkTools } from '../tools/network.ts';
import { registerPageTools } from '../tools/page.ts';
import { registerStateTools } from '../tools/state.ts';
import { registerWebTools } from '../tools/web.ts';

export const handler = async (_args: { command: 'serve' }): Promise<void> => {
	const relay = new RelayConnection();
	const session = new SessionState();

	const server = new McpServer({
		name: 'clicker',
		version: '0.0.0',
	});

	registerDiscoveryTools(server, relay, session);
	registerNavigationTools(server, relay, session);
	registerStateTools(server, relay, session);
	registerInteractionTools(server, relay, session);
	registerPageTools(server, relay, session);
	registerNetworkTools(server, relay, session);
	registerWebTools(server, relay, session);

	relay.on('tab:removed', (workspaceId, tabId) => {
		if (workspaceId !== session.workspaceId || tabId !== session.activeTabId) return;
		// active tab was closed — clear tab selection but preserve console/network state
		session.selectTab(undefined);
	});

	relay.on('tab:active-changed', (workspaceId, tabId) => {
		if (workspaceId !== session.workspaceId) return;
		session.selectTab(tabId);
	});

	relay.on('workspace:destroyed', (workspaceId) => {
		if (workspaceId === session.workspaceId) {
			session.disconnect();
		}
	});

	// buffer console messages, JS errors, and dialog events from the active tab
	/* oxlint-disable no-unsafe-type-assertion, no-base-to-string -- CDP event params are untyped */
	relay.on('cdp:event', (workspaceId, tabId, method, params, eventSessionId) => {
		if (workspaceId !== session.workspaceId) return;
		// only buffer events from the active tab (or when no tab is selected yet)
		if (session.activeTabId !== null && tabId !== session.activeTabId) return;
		const p = params ?? {};
		switch (method) {
			case 'Runtime.consoleAPICalled': {
				const type = typeof p.type === 'string' ? p.type : 'log';
				const args = Array.isArray(p.args) ? p.args : [];
				const first = args[0] as { value?: unknown; description?: string } | undefined;
				const text = first?.value !== undefined ? String(first.value) : (first?.description ?? '');
				session.addConsoleMessage({ timestamp: Date.now(), level: type, text });
				break;
			}
			case 'Runtime.exceptionThrown': {
				const ed = p.exceptionDetails as
					| {
							text?: string;
							exception?: { description?: string };
							lineNumber?: number;
							columnNumber?: number;
					  }
					| undefined;
				const text = ed?.exception?.description ?? ed?.text ?? 'unknown error';
				session.addJsError({
					timestamp: Date.now(),
					text,
					line: ed?.lineNumber,
					column: ed?.columnNumber,
				});
				break;
			}
			case 'Page.javascriptDialogOpening': {
				session.setDialog({
					type: typeof p.type === 'string' ? p.type : 'unknown',
					message: typeof p.message === 'string' ? p.message : '',
					url: typeof p.url === 'string' ? p.url : undefined,
					defaultPrompt: typeof p.defaultPrompt === 'string' ? p.defaultPrompt : undefined,
				});
				break;
			}
			case 'Page.javascriptDialogClosed': {
				session.clearDialog();
				break;
			}
			case 'Page.frameNavigated': {
				// rotate console/error buffers on top-level navigation only;
				// ignore child session events (iframe navigations) and sub-frame navigations
				if (eventSessionId) break;
				const frame = p.frame as { parentId?: string } | undefined;
				if (!frame?.parentId) {
					session.onNavigation();
				}
				break;
			}

			// network events are buffered only while capture_network is active
			case 'Network.requestWillBeSent': {
				const req = p.request as
					| { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
					| undefined;
				const id = typeof p.requestId === 'string' ? p.requestId : '';
				if (id && req) {
					session.updateNetworkRequest(id, tabId, {
						url: typeof req.url === 'string' ? req.url : '',
						method: typeof req.method === 'string' ? req.method : '',
						resourceType: typeof p.type === 'string' ? p.type : '',
						requestHeaders: req.headers,
						postData: req.postData,
						timestamp: typeof p.wallTime === 'number' ? p.wallTime * 1000 : Date.now(),
						monotonicTimestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
					});
				}
				break;
			}
			case 'Network.responseReceived': {
				const resp = p.response as
					| {
							status?: number;
							statusText?: string;
							headers?: Record<string, string>;
							mimeType?: string;
							timing?: Record<string, number>;
							connectionReused?: boolean;
							fromDiskCache?: boolean;
							fromServiceWorker?: boolean;
					  }
					| undefined;
				const id = typeof p.requestId === 'string' ? p.requestId : '';
				if (id && resp) {
					session.updateNetworkRequest(id, tabId, {
						status: typeof resp.status === 'number' ? resp.status : undefined,
						statusText: typeof resp.statusText === 'string' ? resp.statusText : undefined,
						responseHeaders: resp.headers,
						mimeType: typeof resp.mimeType === 'string' ? resp.mimeType : undefined,
						resourceTiming: extractResourceTiming(resp.timing),
						connectionReused: resp.connectionReused,
						fromDiskCache: resp.fromDiskCache,
						fromServiceWorker: resp.fromServiceWorker,
					});
				}
				break;
			}
			case 'Network.loadingFinished': {
				const id = typeof p.requestId === 'string' ? p.requestId : '';
				if (id) {
					session.updateNetworkRequest(id, tabId, {
						encodedDataLength: typeof p.encodedDataLength === 'number' ? p.encodedDataLength : undefined,
						loadingFinishedTimestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
					});
				}
				break;
			}
			case 'Network.loadingFailed': {
				const id = typeof p.requestId === 'string' ? p.requestId : '';
				if (id) {
					session.updateNetworkRequest(id, tabId, {
						failed: true,
						errorText: typeof p.errorText === 'string' ? p.errorText : undefined,
						resourceType: typeof p.type === 'string' ? p.type : undefined,
						loadingFailedTimestamp: typeof p.timestamp === 'number' ? p.timestamp : undefined,
					});
				}
				break;
			}
		}
	});
	/* oxlint-enable no-unsafe-type-assertion, no-base-to-string */

	await relay.connect();
	await server.connect(new StdioServerTransport());

	const shutdown = async () => {
		await server.close();
		relay.close();
		process.exit(0);
	};
	process.on('SIGINT', () => void shutdown());
	process.on('SIGTERM', () => void shutdown());
};

/** extracts a typed ResourceTiming from the raw CDP timing object, if present */
const extractResourceTiming = (timing: Record<string, number> | undefined): ResourceTiming | undefined => {
	if (!timing || typeof timing.requestTime !== 'number') return undefined;
	const num = (key: string) => {
		const val = timing[key];
		return typeof val === 'number' ? val : -1;
	};
	return {
		requestTime: num('requestTime'),
		dnsStart: num('dnsStart'),
		dnsEnd: num('dnsEnd'),
		connectStart: num('connectStart'),
		connectEnd: num('connectEnd'),
		sslStart: num('sslStart'),
		sslEnd: num('sslEnd'),
		sendStart: num('sendStart'),
		sendEnd: num('sendEnd'),
		receiveHeadersStart: num('receiveHeadersStart'),
		receiveHeadersEnd: num('receiveHeadersEnd'),
	};
};
