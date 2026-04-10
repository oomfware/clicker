import type { BrowserStatus } from '@oomfware/clicker-protocol';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { RelayConnection } from '../connection.ts';
import type { SessionState } from '../session.ts';

import { enableNetworkForActiveTab, formatTabLine } from './shared.ts';

export const registerDiscoveryTools = (
	server: McpServer,
	relay: RelayConnection,
	session: SessionState,
): void => {
	server.registerTool(
		'status',
		{
			description:
				'Show connected browsers, their workspaces, and tabs, plus current session state. Call this first to discover targets, then connect_workspace() or create_workspace() to bind.',
			inputSchema: {
				browser_id: z.string().optional().describe('Filter to a specific browser by its connection ID'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ browser_id }) => {
			const response = await relay.request({
				type: 'status:query',
				connectionId: browser_id,
			});
			if (response.payload.type !== 'status:result') {
				return {
					content: [{ type: 'text', text: 'Unexpected response from relay.' }],
					isError: true,
				};
			}

			const { browsers } = response.payload;
			if (browsers.length === 0) {
				if (browser_id) {
					return {
						content: [
							{
								type: 'text',
								text: `No browser found for "${browser_id}". Call status() without browser_id to see all connections.`,
							},
						],
						isError: true,
					};
				}
				return {
					content: [
						{
							type: 'text',
							text: 'No browsers connected. Make sure the clicker extension is installed and the browser is open.',
						},
					],
				};
			}

			return { content: [{ type: 'text', text: formatStatus(browsers, session) }] };
		},
	);

	server.registerTool(
		'create_workspace',
		{
			description:
				'Create a new workspace (tab group) in a browser and connect to it. The new workspace becomes the active session target.',
			inputSchema: {
				browser_id: z.string().describe('Browser connection ID from status'),
				title: z.string().describe('A short name for the workspace; ask the user if unclear'),
			},
		},
		async ({ browser_id, title }) => {
			const response = await relay.request({
				type: 'workspace:create',
				connectionId: browser_id,
				title,
			});
			const { payload } = response;

			if (payload.type !== 'workspace:created') {
				return {
					content: [{ type: 'text', text: 'Failed to create workspace.' }],
					isError: true,
				};
			}
			if (!payload.result.ok) {
				return {
					content: [{ type: 'text', text: payload.result.error }],
					isError: true,
				};
			}

			const { workspace } = payload.result;
			const activeTabId = workspace.tabs[0]?.tabId;
			session.connectWorkspace(browser_id, workspace.id, activeTabId);
			enableNetworkForActiveTab(relay, session);

			const tabList = workspace.tabs.map((t) => formatTabLine(t, activeTabId)).join('\n');

			return {
				content: [
					{
						type: 'text',
						text: `Workspace "${workspace.title}" created and connected.\nTabs:\n${tabList}`,
					},
				],
			};
		},
	);

	server.registerTool(
		'connect_workspace',
		{
			description:
				'Connect this session to an existing workspace. Use status() first to find the workspace ID.',
			inputSchema: {
				workspace_id: z.string().describe('Workspace ID from status'),
			},
		},
		async ({ workspace_id }) => {
			const response = await relay.request({ type: 'workspace:bind', workspaceId: workspace_id });
			if (response.payload.type !== 'workspace:bound') {
				return {
					content: [{ type: 'text', text: 'Failed to bind workspace.' }],
					isError: true,
				};
			}
			if (!response.payload.result.ok) {
				return {
					content: [{ type: 'text', text: response.payload.result.error }],
					isError: true,
				};
			}

			const { connectionId, workspace, otherSessions } = response.payload.result;
			const activeTabId = workspace.tabs.find((tab) => tab.active)?.tabId ?? workspace.tabs[0]?.tabId;
			session.connectWorkspace(connectionId, workspace_id, activeTabId);
			enableNetworkForActiveTab(relay, session);

			const tabList = workspace.tabs.map((t) => formatTabLine(t, activeTabId)).join('\n');
			let text = `Connected to workspace "${workspace.title}".\nTabs:\n${tabList}`;
			if (otherSessions > 0) {
				text += `\nNote: ${otherSessions} other session${otherSessions > 1 ? 's' : ''} also connected to this workspace.`;
			}

			return { content: [{ type: 'text', text }] };
		},
	);

	server.registerTool(
		'destroy_workspace',
		{
			description:
				'Close all tabs in a workspace and destroy it. Unbinds the session if the destroyed workspace was the current one.',
			inputSchema: {
				workspace_id: z.string().describe('Workspace ID to destroy'),
			},
		},
		async ({ workspace_id }) => {
			const response = await relay.request({ type: 'workspace:destroy', workspaceId: workspace_id });
			if (response.payload.type !== 'workspace:destroyed') {
				return { content: [{ type: 'text', text: 'Failed to destroy workspace.' }], isError: true };
			}
			if (!response.payload.result.ok) {
				return {
					content: [{ type: 'text', text: response.payload.result.error }],
					isError: true,
				};
			}

			if (session.workspaceId === workspace_id) {
				session.disconnect();
			}

			return { content: [{ type: 'text', text: `Destroyed workspace ${workspace_id}.` }] };
		},
	);
};

// #region status formatting

const formatStatus = (browsers: BrowserStatus[], session: SessionState): string => {
	const lines: string[] = [];

	// session state
	if (session.isConnected) {
		lines.push('Session: connected');
		lines.push(`  Browser: ${session.connectionId}`);
		lines.push(`  Workspace: ${session.workspaceId}`);
		if (session.activeTabId !== null) {
			lines.push(`  Tab: ${session.activeTabId}`);
		}
		lines.push(`  Refs: ${session.refCount}`);
		const dialog = session.getDialog();
		if (dialog) {
			lines.push(`  Dialog: ${dialog.type} — "${dialog.message}"`);
		}
	} else {
		lines.push('Session: not connected');
	}

	lines.push('');

	// browser tree
	for (const browser of browsers) {
		const isCurrent = browser.connectionId === session.connectionId;
		const marker = isCurrent ? ' (current)' : '';
		lines.push(`Browser: ${browser.name}${marker} — id: ${browser.connectionId}`);

		if (!browser.synced) {
			lines.push('  (syncing...)');
			continue;
		}

		if (browser.workspaces.length === 0) {
			lines.push('  No workspaces. Use create_workspace to create one.');
			continue;
		}

		for (const ws of browser.workspaces) {
			const wsIsCurrent = ws.id === session.workspaceId;
			const wsMarker = wsIsCurrent ? ' (current)' : '';
			lines.push(`  Workspace: "${ws.title}"${wsMarker} — id: ${ws.id}`);

			if (ws.tabs.length === 0) {
				lines.push('    (no tabs)');
			}
			for (const tab of ws.tabs) {
				const tabIsCurrent = tab.tabId === session.activeTabId && wsIsCurrent;
				const tabMarker = tabIsCurrent ? ' (current)' : '';
				lines.push(`    [${tab.tabId}] ${tab.title} (${tab.url})${tabMarker}`);
			}
		}
	}

	if (browsers.length > 1) {
		lines.push('');
		lines.push('Multiple browsers connected — ask the user which one to use.');
	}

	return lines.join('\n');
};

// #endregion
