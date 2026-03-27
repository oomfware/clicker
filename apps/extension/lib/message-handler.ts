import { formatError, type RelayToExtensionMessage } from '@oomfware/clicker-protocol';

import type { RelayConnection } from './connection.ts';
import type { DebuggerBridge } from './debugger-bridge.ts';
import type { WorkspaceManager } from './workspace-manager.ts';

export const handleRelayMessage = async (
	msg: RelayToExtensionMessage,
	workspaces: WorkspaceManager,
	debugger_: DebuggerBridge,
	send: RelayConnection['send'],
): Promise<void> => {
	switch (msg.payload.type) {
		case 'workspace:create': {
			try {
				const workspace = await workspaces.create(msg.payload.title);
				// debugger attach is best-effort — don't roll back workspace on failure
				void debugger_.attachAll(workspace.tabs.map((t) => t.tabId)).catch((err) => {
					console.warn('failed to attach debugger to new workspace tabs:', err);
				});
				send({ type: 'workspace:created', replyTo: msg.id, result: { ok: true, workspace } });
			} catch (err) {
				send({
					type: 'workspace:created',
					replyTo: msg.id,
					result: {
						ok: false,
						error: `workspace creation failed: ${formatError(err)}`,
					},
				});
			}
			break;
		}

		case 'workspace:destroy': {
			try {
				const workspace = workspaces.get(msg.payload.workspaceId);
				if (workspace) {
					await debugger_.detachAll(workspace.tabs.map((t) => t.tabId));
				}
				const destroyed = await workspaces.destroy(msg.payload.workspaceId);
				send({
					type: 'workspace:destroyed',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					result: destroyed ? { ok: true } : { ok: false, error: 'workspace not found' },
				});
			} catch (err) {
				send({
					type: 'workspace:destroyed',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					result: {
						ok: false,
						error: `workspace destroy failed: ${formatError(err)}`,
					},
				});
			}
			break;
		}

		case 'tab:create': {
			try {
				const tab = await workspaces.createTab(msg.payload.workspaceId, msg.payload.url, msg.payload.active);
				if (msg.payload.active) {
					await debugger_.attach(tab.tabId);
				} else {
					void debugger_.attach(tab.tabId).catch((err) => {
						console.warn(`failed to attach debugger to created tab ${tab.tabId}:`, err);
					});
				}
				send({
					type: 'tab:created',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					result: { ok: true, tab },
				});
			} catch (err) {
				send({
					type: 'tab:created',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					result: {
						ok: false,
						error: `tab creation failed: ${formatError(err)}`,
					},
				});
			}
			break;
		}

		case 'tab:activate': {
			try {
				const ok = await workspaces.activateTab(msg.payload.workspaceId, msg.payload.tabId);
				if (!ok) throw new Error('tab not found in workspace');
				send({
					type: 'tab:activated',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					tabId: msg.payload.tabId,
					result: { ok: true },
				});
			} catch (err) {
				send({
					type: 'tab:activated',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					tabId: msg.payload.tabId,
					result: {
						ok: false,
						error: `tab activation failed: ${formatError(err)}`,
					},
				});
			}
			break;
		}

		case 'tab:close': {
			try {
				const ok = await workspaces.closeTab(msg.payload.workspaceId, msg.payload.tabId);
				if (!ok) throw new Error('tab not found in workspace');
				send({
					type: 'tab:closed',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					tabId: msg.payload.tabId,
					result: { ok: true },
				});
			} catch (err) {
				send({
					type: 'tab:closed',
					replyTo: msg.id,
					workspaceId: msg.payload.workspaceId,
					tabId: msg.payload.tabId,
					result: {
						ok: false,
						error: `tab close failed: ${formatError(err)}`,
					},
				});
			}
			break;
		}

		case 'cdp:command': {
			const { workspaceId, tabId, method, params, frameId } = msg.payload;
			if (tabId === undefined) {
				send({ type: 'cdp:result', replyTo: msg.id, result: { ok: false, error: 'no tab selected' } });
				break;
			}

			if (workspaces.findByTabId(tabId) !== workspaceId) {
				send({
					type: 'cdp:result',
					replyTo: msg.id,
					result: { ok: false, error: `tab ${tabId} does not belong to workspace ${workspaceId}` },
				});
				break;
			}

			// auto-attach if not already attached
			if (!debugger_.isAttached(tabId)) {
				try {
					await debugger_.attach(tabId);
				} catch (err) {
					send({
						type: 'cdp:result',
						replyTo: msg.id,
						result: {
							ok: false,
							error: `failed to attach debugger: ${formatError(err)}`,
						},
					});
					break;
				}
			}

			try {
				const result =
					method === 'Input.dispatchMouseEvent'
						? await debugger_.sendInputCommand(tabId, params, frameId)
						: await debugger_.sendCommand(tabId, method, params, frameId);
				send({ type: 'cdp:result', replyTo: msg.id, result: { ok: true, value: result } });
			} catch (err) {
				send({
					type: 'cdp:result',
					replyTo: msg.id,
					result: { ok: false, error: formatError(err) },
				});
			}
			break;
		}

		case 'relay:welcome':
		case 'ping':
			// handled by connection layer, listed for exhaustiveness
			break;

		default: {
			// oxlint-disable-next-line no-unused-vars -- compile-time exhaustiveness check
			const _exhaustive: never = msg.payload;
		}
	}
};
