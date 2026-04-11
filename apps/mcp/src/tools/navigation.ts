import { isRestrictedUrl, TOOL_TIMEOUT_DEFAULT } from '@oomfware/clicker-protocol';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { clampTimeout, sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { SessionState } from '../session.ts';

import { enableNetworkForActiveTab, formatTabLine, notConnectedError } from './shared.ts';

const readLocationHref = async (relay: RelayConnection, session: SessionState): Promise<string | null> => {
	try {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
			expression: 'location.href',
			returnByValue: true,
		})) as { result?: { value?: unknown } };
		return typeof result.result?.value === 'string' ? result.result.value : null;
	} catch {
		return null;
	}
};

type NavigationWaitResult =
	| { outcome: 'navigated'; finalUrl: string | null }
	| { outcome: 'timed_out'; finalUrl: string | null };

/** waits for the URL to change from `previousUrl` or match `requestedUrl` */
const waitForUrlChange = async (
	relay: RelayConnection,
	session: SessionState,
	previousUrl: string | null,
	requestedUrl: string,
	timeoutMs = 5_000,
	signal?: AbortSignal,
): Promise<string | null> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) return null;
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		const href = await readLocationHref(relay, session);
		if (href && (href !== previousUrl || href === requestedUrl)) {
			return href;
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	return null;
};

/** SPA/history quiet window — resolve after URL changes and no further changes for this duration */
const SPA_QUIET_MS = 150;

/**
 * waits for a page load event via the relay event emitter.
 * resolves with whether a load event was seen before timeout/cancellation.
 */
const waitForPageLoad = (
	relay: RelayConnection,
	session: SessionState,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<boolean> => {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}

		let settled = false;
		const cleanup = (loaded: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			relay.removeListener('cdp:event', onEvent);
			signal.removeEventListener('abort', onAbort);
			resolve(loaded);
		};
		const onAbort = () => {
			cleanup(false);
		};

		const timer = setTimeout(() => {
			cleanup(false);
		}, timeoutMs);
		signal.addEventListener('abort', onAbort);

		const onEvent = (
			workspaceId: string,
			tabId: number,
			method: string,
			_params?: Record<string, unknown>,
			eventSessionId?: string,
		) => {
			if (settled) return;
			if (workspaceId !== session.workspaceId) return;
			if (session.activeTabId !== null && tabId !== session.activeTabId) return;
			if (eventSessionId) return;
			if (method !== 'Page.loadEventFired') return;
			cleanup(true);
		};
		relay.on('cdp:event', onEvent);
	});
};

/**
 * waits for navigation to settle. handles both document and SPA/history navigations:
 * - document navigations: resolves on Page.loadEventFired
 * - SPA/history navigations: resolves on URL change + quiet window
 *
 * clears stale state after navigation settles.
 */
const waitForNavigation = async (
	relay: RelayConnection,
	session: SessionState,
	previousUrl: string | null,
	expectedUrl?: string,
	timeoutMs = 5_000,
): Promise<NavigationWaitResult> => {
	const abort = new AbortController();
	const pageLoad = waitForPageLoad(relay, session, timeoutMs, abort.signal);
	const urlChange = waitForUrlChange(relay, session, previousUrl, expectedUrl ?? '', timeoutMs, abort.signal);

	const result = await Promise.race([
		pageLoad.then(async (loaded): Promise<NavigationWaitResult> => {
			if (!loaded) {
				return {
					outcome: 'timed_out',
					finalUrl: await readLocationHref(relay, session),
				};
			}
			return {
				outcome: 'navigated',
				finalUrl: await readLocationHref(relay, session),
			};
		}),
		urlChange.then(async (href): Promise<NavigationWaitResult> => {
			if (!href || href === previousUrl) {
				return new Promise<never>(() => {});
			}
			await new Promise((resolve) => setTimeout(resolve, SPA_QUIET_MS));
			return {
				outcome: 'navigated',
				finalUrl: await readLocationHref(relay, session),
			};
		}),
	]);

	abort.abort();
	if (result.outcome === 'navigated') {
		session.onNavigation(session.activeTabId);
	}
	return result;
};

export const registerNavigationTools = (
	server: McpServer,
	relay: RelayConnection,
	session: SessionState,
): void => {
	server.registerTool(
		'navigate',
		{
			description: 'Navigate to a URL. Auto-handles beforeunload dialogs.',
			inputSchema: {
				url: z.string().describe('URL to navigate to'),
				target: z
					.enum(['current', 'foreground_tab', 'background_tab'])
					.default('current')
					.describe('Where to open the URL: current tab, new active tab, or new background tab'),
				timeout: z
					.number()
					.default(TOOL_TIMEOUT_DEFAULT)
					.describe('Navigation timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ url, target, timeout }) => {
			if (!session.isConnected) {
				return notConnectedError();
			}

			if (isRestrictedUrl(url)) {
				return {
					content: [{ type: 'text', text: `Cannot navigate to restricted URL: ${url}` }],
					isError: true,
				};
			}

			const timeoutMs = clampTimeout(timeout);

			// dismiss any pending beforeunload dialog that might block navigation
			try {
				await sendCdpCommand(relay, session, 'Page.handleJavaScriptDialog', { accept: true });
			} catch {
				// no dialog pending — expected
			}

			if (target === 'foreground_tab' || target === 'background_tab') {
				const response = await relay.request({
					type: 'tab:create',
					workspaceId: session.workspaceId!,
					url,
					active: target === 'foreground_tab',
				});
				const { payload } = response;
				if (payload.type !== 'tab:created') {
					return {
						content: [{ type: 'text', text: 'Failed to open a new tab.' }],
						isError: true,
					};
				}
				if (!payload.result.ok) {
					return {
						content: [{ type: 'text', text: payload.result.error }],
						isError: true,
					};
				}

				if (target === 'foreground_tab') {
					session.selectTab(payload.result.tab.tabId);
					enableNetworkForActiveTab(relay, session);
				}

				const label = target === 'background_tab' ? 'background tab' : 'new tab';
				return {
					content: [
						{
							type: 'text',
							text: `Opened ${url} in a ${label} (tab_id=${payload.result.tab.tabId}).`,
						},
					],
				};
			}

			const previousUrl = await readLocationHref(relay, session);
			// start waiters before navigation so fast loads don't miss Page.loadEventFired
			const navigation = waitForNavigation(relay, session, previousUrl, url, timeoutMs);
			await sendCdpCommand(relay, session, 'Page.navigate', { url });
			const { outcome, finalUrl } = await navigation;

			if (outcome === 'timed_out') {
				return {
					content: [
						{
							type: 'text',
							text: finalUrl
								? `Timed out waiting for navigation to ${url}. Current page is ${finalUrl}.`
								: `Timed out waiting for navigation to ${url}.`,
						},
					],
					isError: true,
				};
			}

			if (previousUrl && previousUrl !== url && finalUrl === previousUrl) {
				return {
					content: [
						{
							type: 'text',
							text: `Navigation to ${url} did not change the current page (still at ${finalUrl}).`,
						},
					],
					isError: true,
				};
			}

			const resolvedUrl = finalUrl ?? url;
			return {
				content: [
					{
						type: 'text',
						text: resolvedUrl === url ? `Navigated to ${url}.` : `Navigated to ${resolvedUrl}.`,
					},
				],
			};
		},
	);

	server.registerTool(
		'go_back',
		{
			description: 'Navigate the active tab back in history.',
			inputSchema: {
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Navigation timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const previousUrl = await readLocationHref(relay, session);
			const navigation = waitForNavigation(relay, session, previousUrl, undefined, clampTimeout(timeout));
			await sendCdpCommand(relay, session, 'Runtime.evaluate', { expression: 'history.back()' });
			const { outcome, finalUrl } = await navigation;
			if (outcome === 'timed_out' || finalUrl === previousUrl) {
				return {
					content: [
						{
							type: 'text',
							text: previousUrl
								? `Could not navigate back. Current page is still ${previousUrl}.`
								: 'Could not navigate back.',
						},
					],
					isError: true,
				};
			}
			return { content: [{ type: 'text', text: `Navigated back to ${finalUrl ?? 'unknown URL'}.` }] };
		},
	);

	server.registerTool(
		'go_forward',
		{
			description: 'Navigate the active tab forward in history.',
			inputSchema: {
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Navigation timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const previousUrl = await readLocationHref(relay, session);
			const navigation = waitForNavigation(relay, session, previousUrl, undefined, clampTimeout(timeout));
			await sendCdpCommand(relay, session, 'Runtime.evaluate', { expression: 'history.forward()' });
			const { outcome, finalUrl } = await navigation;
			if (outcome === 'timed_out' || finalUrl === previousUrl) {
				return {
					content: [
						{
							type: 'text',
							text: previousUrl
								? `Could not navigate forward. Current page is still ${previousUrl}.`
								: 'Could not navigate forward.',
						},
					],
					isError: true,
				};
			}
			return {
				content: [{ type: 'text', text: `Navigated forward to ${finalUrl ?? 'unknown URL'}.` }],
			};
		},
	);

	server.registerTool(
		'reload',
		{
			description: 'Reload the active tab.',
			inputSchema: {
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Reload timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const abort = new AbortController();
			const timeoutMs = clampTimeout(timeout);
			const load = waitForPageLoad(relay, session, timeoutMs, abort.signal);
			await sendCdpCommand(relay, session, 'Page.reload', {});
			const loaded = await load;
			if (!loaded) {
				const currentUrl = await readLocationHref(relay, session);
				return {
					content: [
						{
							type: 'text',
							text: currentUrl
								? `Timed out waiting for ${currentUrl} to reload.`
								: 'Timed out waiting for the page to reload.',
						},
					],
					isError: true,
				};
			}
			session.onNavigation(session.activeTabId);
			return { content: [{ type: 'text', text: 'Page reloaded.' }] };
		},
	);

	server.registerTool(
		'navigation_history',
		{
			description: 'Show the back/forward navigation history for the active tab.',
			annotations: { readOnlyHint: true },
		},
		async () => {
			if (!session.isConnected) return notConnectedError();

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const history = (await sendCdpCommand(relay, session, 'Page.getNavigationHistory', {})) as {
				currentIndex: number;
				entries: { url: string; title: string; transitionType: string }[];
			};

			const { currentIndex, entries } = history;
			const forward = entries.length - currentIndex - 1;
			const header = `Navigation history: ${entries.length} entries | current: ${currentIndex} | back: ${currentIndex} | forward: ${forward}`;

			const lines = entries.map((entry, i) => {
				const marker = i === currentIndex ? '> ' : '  ';
				const title = entry.title ? ` — ${entry.title}` : '';
				return `${marker}[${i}] ${entry.transitionType} ${entry.url}${title}`;
			});

			return { content: [{ type: 'text', text: `${header}\n${lines.join('\n')}` }] };
		},
	);

	server.registerTool(
		'list_tabs',
		{
			description:
				'List all tabs in the current workspace. Shortcut for checking tabs when already connected — status() provides the same information plus more context.',
			annotations: { readOnlyHint: true },
		},
		async () => {
			if (!session.isConnected) {
				return notConnectedError();
			}

			const response = await relay.request({ type: 'workspace:list', connectionId: session.connectionId! });
			if (response.payload.type !== 'workspace:state') {
				return { content: [{ type: 'text', text: 'Failed to list tabs.' }], isError: true };
			}
			if (!response.payload.result.ok) {
				return { content: [{ type: 'text', text: response.payload.result.error }], isError: true };
			}

			const ws = response.payload.result.workspaces.find((w) => w.id === session.workspaceId);
			if (!ws) {
				return { content: [{ type: 'text', text: 'Workspace not found.' }], isError: true };
			}

			const lines = ws.tabs.map((t) => formatTabLine(t, session.activeTabId)).join('\n');

			return { content: [{ type: 'text', text: lines }] };
		},
	);

	server.registerTool(
		'select_tab',
		{
			description: 'Switch the active tab within the workspace for subsequent operations.',
			inputSchema: {
				tab_id: z
					.number()
					.optional()
					.describe('Tab ID from status or list_tabs; omit to infer when unambiguous'),
				foreground: z.boolean().default(false).describe('Also activate the Chrome tab in the browser UI'),
			},
		},
		async ({ tab_id, foreground }) => {
			if (!session.isConnected) {
				return notConnectedError();
			}

			const response = await relay.request({ type: 'workspace:list', connectionId: session.connectionId! });
			if (response.payload.type !== 'workspace:state') {
				return { content: [{ type: 'text', text: 'Failed to list tabs.' }], isError: true };
			}
			if (!response.payload.result.ok) {
				return { content: [{ type: 'text', text: response.payload.result.error }], isError: true };
			}

			const workspace = response.payload.result.workspaces.find((ws) => ws.id === session.workspaceId);
			if (!workspace) {
				return { content: [{ type: 'text', text: 'Workspace not found.' }], isError: true };
			}

			let targetTabId = tab_id;
			if (targetTabId === undefined) {
				const activeTabs = workspace.tabs.filter((tab) => tab.active);
				if (activeTabs.length === 1) {
					targetTabId = activeTabs[0].tabId;
				} else if (workspace.tabs.length === 1) {
					targetTabId = workspace.tabs[0].tabId;
				}
			}

			if (targetTabId === undefined) {
				const choices = workspace.tabs.map((tab) => `[${tab.tabId}] ${tab.title} (${tab.url})`).join('\n');
				return {
					content: [
						{
							type: 'text',
							text: `Select a tab by id. Available tabs:\n${choices}`,
						},
					],
					isError: true,
				};
			}

			if (!workspace.tabs.some((tab) => tab.tabId === targetTabId)) {
				return {
					content: [{ type: 'text', text: `Tab ${targetTabId} is not in the current workspace.` }],
					isError: true,
				};
			}

			if (foreground) {
				const activateResponse = await relay.request({
					type: 'tab:activate',
					workspaceId: session.workspaceId!,
					tabId: targetTabId,
				});
				const { payload } = activateResponse;
				if (payload.type !== 'tab:activated') {
					return { content: [{ type: 'text', text: 'Failed to activate tab.' }], isError: true };
				}
				if (!payload.result.ok) {
					return {
						content: [{ type: 'text', text: payload.result.error }],
						isError: true,
					};
				}
			}

			session.selectTab(targetTabId);
			enableNetworkForActiveTab(relay, session);
			return {
				content: [
					{
						type: 'text',
						text: foreground
							? `Selected tab ${targetTabId} and brought it to the foreground.`
							: `Selected tab ${targetTabId}.`,
					},
				],
			};
		},
	);

	server.registerTool(
		'close_tab',
		{
			description: 'Close a tab in the workspace.',
			inputSchema: {
				tab_id: z.number().optional().describe('Tab ID to close (closes the active tab if omitted)'),
			},
		},
		async ({ tab_id }) => {
			if (!session.isConnected) {
				return notConnectedError();
			}

			const targetTab = tab_id ?? session.activeTabId;
			if (!targetTab) {
				return { content: [{ type: 'text', text: 'No tab to close.' }], isError: true };
			}

			const response = await relay.request({
				type: 'tab:close',
				workspaceId: session.workspaceId!,
				tabId: targetTab,
			});
			const { payload } = response;
			if (payload.type !== 'tab:closed') {
				return { content: [{ type: 'text', text: 'Failed to close tab.' }], isError: true };
			}
			if (!payload.result.ok) {
				return {
					content: [{ type: 'text', text: payload.result.error }],
					isError: true,
				};
			}

			// if we closed the active tab, clear selection so the next command doesn't target a dead tab
			if (targetTab === session.activeTabId) {
				session.selectTab(undefined);
			}

			return { content: [{ type: 'text', text: `Closed tab ${targetTab}.` }] };
		},
	);
};
