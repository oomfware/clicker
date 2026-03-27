import { WS_CLOSE_HANDSHAKE_REJECTED, formatError } from '@oomfware/clicker-protocol';

import { RelayConnection } from '../lib/connection.ts';
import { DebuggerBridge } from '../lib/debugger-bridge.ts';
import { handleRelayMessage } from '../lib/message-handler.ts';
import { getExtensionName, isCustomName, regenerateName, setExtensionName } from '../lib/name.ts';
import { POPUP_PORT_NAME, parsePopupMessage, type PopupState } from '../lib/popup-messages.ts';
import { startTabTracker, type TabIntent } from '../lib/tab-tracker.ts';
import { WorkspaceManager, parseGroupTitle, resolveTabGroupColor } from '../lib/workspace-manager.ts';

export default defineBackground(async () => {
	const workspaces = new WorkspaceManager();
	await workspaces.discover();

	let currentName = await getExtensionName();
	let error: PopupState['error'] | null = null;

	const updateBadge = () => {
		if (error) {
			void chrome.action.setBadgeText({ text: '!' });
			void chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
		} else {
			void chrome.action.setBadgeText({ text: '' });
		}
	};

	// #region popup state push

	const popupPorts = new Set<chrome.runtime.Port>();

	const pushPopupState = () => {
		if (popupPorts.size === 0) return;
		const s: PopupState = {
			name: currentName,
			connected: connection.connected,
			error: error ?? undefined,
			workspaces: workspaces.list(),
		};
		for (const port of popupPorts) {
			port.postMessage(s);
		}
	};

	chrome.runtime.onConnect.addListener((port) => {
		if (port.name !== POPUP_PORT_NAME) return;
		popupPorts.add(port);
		port.onDisconnect.addListener(() => popupPorts.delete(port));
		pushPopupState();
	});

	// #endregion

	const debuggerBridge = new DebuggerBridge({
		onCdpEvent: (tabId, method, params, sessionId) => {
			const workspaceId = workspaces.findByTabId(tabId);
			if (!workspaceId) return;
			connection.send({ type: 'cdp:event', workspaceId, tabId, method, params, sessionId });
		},
		onDetached: (tabId, reason) => {
			console.log(`debugger detached from tab ${tabId}: ${reason}`);
		},
	});

	// #region mutation queue

	let mutationQueue: Promise<void> = Promise.resolve();
	let topologyDirty = false;

	/** serializes a workspace mutation; emits a snapshot to relay and pushes popup state after */
	const enqueue = (fn: () => Promise<void>): void => {
		mutationQueue = mutationQueue
			.then(fn)
			.then(() => {
				if (topologyDirty && connection.connected) {
					connection.send({ type: 'workspace:sync', workspaces: workspaces.list() });
					topologyDirty = false;
				}
				pushPopupState();
			})
			.catch((err) => {
				console.error('mutation queue error:', err);
			});
	};

	/** marks that topology changed, so the next queue drain emits a sync */
	const markDirty = () => {
		topologyDirty = true;
	};

	// #endregion

	// #region tab mutation helpers

	const notifyTabRemoved = async (tabId: number): Promise<void> => {
		const result = await workspaces.removeTab(tabId);
		if (!result) return;

		markDirty();
		connection.send({ type: 'tab:removed', workspaceId: result.workspaceId, tabId });
		void debuggerBridge.detach(tabId);
		if (result.workspaceRemoved) {
			connection.send({
				type: 'workspace:destroyed',
				workspaceId: result.workspaceId,
				result: { ok: true },
			});
		}
	};

	const notifyTabAdopted = async (workspaceId: string, tabId: number): Promise<void> => {
		const tab = await chrome.tabs.get(tabId);
		const added = await workspaces.addTab(workspaceId, tab);
		if (!added) return;

		markDirty();
		connection.send({
			type: 'tab:adopted',
			workspaceId,
			tabId,
			url: tab.url ?? '',
			title: tab.title ?? '',
		});
		void debuggerBridge.attach(tabId).catch((err) => {
			console.warn(`failed to attach debugger to tab ${tabId}:`, err);
		});
	};

	const notifyWorkspaceDisowned = (groupId: number): void => {
		const removed = workspaces.disownGroup(groupId);
		if (!removed) return;

		markDirty();
		connection.send({
			type: 'workspace:destroyed',
			workspaceId: removed.workspaceId,
			result: { ok: true },
		});
		if (removed.tabIds.length > 0) {
			void debuggerBridge.detachAll(removed.tabIds);
		}
	};

	// #endregion

	// #region tab intent processing

	const processTabIntent = async (intent: TabIntent): Promise<void> => {
		switch (intent.type) {
			case 'tab-created': {
				const { tab } = intent;
				const workspaceId = workspaces.findByTabId(tab.openerTabId!);
				if (!workspaceId) return;
				await notifyTabAdopted(workspaceId, tab.id!);
				break;
			}

			case 'tab-removed': {
				await notifyTabRemoved(intent.tabId);
				break;
			}

			case 'tab-updated': {
				const { tabId, url, title, groupId } = intent;

				if (url || title) {
					workspaces.updateTab(tabId, url, title);
					const workspaceId = workspaces.findByTabId(tabId);
					if (workspaceId) {
						connection.send({ type: 'tab:updated', workspaceId, tabId, url, title });
					}
				}

				if (groupId === undefined) break;

				const currentWorkspace = workspaces.findByTabId(tabId);
				const newWorkspace = workspaces.findByGroupId(groupId);

				if (currentWorkspace && !newWorkspace) {
					await notifyTabRemoved(tabId);
				} else if (!currentWorkspace && newWorkspace) {
					await notifyTabAdopted(newWorkspace, tabId);
				} else if (currentWorkspace && newWorkspace && currentWorkspace !== newWorkspace) {
					await notifyTabRemoved(tabId);
					await notifyTabAdopted(newWorkspace, tabId);
				}
				break;
			}

			case 'tab-activated': {
				workspaces.setTabActive(intent.tabId, true);
				const workspaceId = workspaces.findByTabId(intent.tabId);
				if (workspaceId) {
					connection.send({ type: 'tab:active-changed', workspaceId, tabId: intent.tabId });
				}
				break;
			}

			case 'group-updated': {
				const { groupId, title: rawTitle, color: rawColor } = intent;
				const name = parseGroupTitle(rawTitle);
				const isTracked = workspaces.findByGroupId(groupId) !== undefined;
				const color = resolveTabGroupColor(rawColor);

				if (name && !isTracked) {
					const workspace = await workspaces.adoptGroup(groupId, name, color);
					if (workspace) {
						markDirty();
						connection.send({ type: 'workspace:created', result: { ok: true, workspace } });
						void debuggerBridge.attachAll(workspace.tabs.map((t) => t.tabId)).catch((err) => {
							console.warn('failed to attach debugger to adopted workspace tabs:', err);
						});
					}
				} else if (!name && isTracked) {
					notifyWorkspaceDisowned(groupId);
				} else if (name && isTracked) {
					const workspaceId = workspaces.findByGroupId(groupId);
					workspaces.updateGroup(groupId, name, color);
					if (workspaceId) {
						connection.send({ type: 'workspace:updated', workspaceId, title: name });
					}
				}
				break;
			}

			case 'group-removed': {
				notifyWorkspaceDisowned(intent.groupId);
				break;
			}
		}
	};

	// #endregion

	// #region relay connection

	const connection = new RelayConnection(currentName, {
		onConnect: (connectionId) => {
			console.log(`connected to relay: ${connectionId}`);
			error = null;
			updateBadge();
			// force a sync on connect regardless of dirty flag
			enqueue(async () => {
				markDirty();
			});
		},
		onReject: (code, reason) => {
			console.log(`relay rejected connection: ${code} ${reason}`);

			if (code === WS_CLOSE_HANDSHAKE_REJECTED && reason === 'name_conflict') {
				void isCustomName().then((custom) => {
					if (!custom) {
						void regenerateName().then((name) => {
							currentName = name;
							connection.reconnectWithName(name);
						});
						return;
					}
					error = 'name_conflict';
					updateBadge();
					pushPopupState();
				});
			} else {
				error = 'version_mismatch';
				updateBadge();
				pushPopupState();
			}
		},
		onDisconnect: () => {
			console.log('disconnected from relay, will reconnect...');
			error = null;
			updateBadge();
			pushPopupState();
		},
		onMessage: (msg) => {
			enqueue(() =>
				handleRelayMessage(msg, workspaces, debuggerBridge, (payload) => {
					markDirty();
					connection.send(payload);
				}),
			);
		},
	});

	// #endregion

	startTabTracker((intent) => {
		enqueue(() => processTabIntent(intent));
	});

	updateBadge();
	connection.start();

	// #region popup message handler

	chrome.runtime.onMessage.addListener((raw, _sender, sendResponse) => {
		const msg = parsePopupMessage(raw);
		if (!msg) return false;

		switch (msg.type) {
			case 'popup:setName': {
				const previousName = currentName;
				const name = msg.name.trim();
				if (!name) {
					sendResponse({ ok: false, error: 'name cannot be empty' });
					return false;
				}
				currentName = name;
				pushPopupState();
				void setExtensionName(name)
					.then(() => {
						connection.reconnectWithName(name);
						sendResponse({ ok: true });
					})
					.catch((err) => {
						currentName = previousName;
						pushPopupState();
						sendResponse({ ok: false, error: formatError(err) });
					});
				return true; // async response
			}

			case 'popup:createFromTab': {
				const { name } = msg;
				enqueue(async () => {
					try {
						const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
						if (!tab?.id) {
							sendResponse({ ok: false, error: 'no active tab' });
							return;
						}

						const workspace = await workspaces.createFromTab(tab, name);
						markDirty();

						void debuggerBridge.attach(tab.id).catch((err) => {
							console.warn(`failed to attach debugger to tab ${tab.id}:`, err);
						});

						connection.send({ type: 'workspace:created', result: { ok: true, workspace } });
						sendResponse({ ok: true });
					} catch (err) {
						sendResponse({ ok: false, error: formatError(err) });
					}
				});
				return true; // async response
			}

			default: {
				// oxlint-disable-next-line no-unused-vars -- compile-time exhaustiveness check
				const _exhaustive: never = msg;
			}
		}
	});

	// #endregion
});
