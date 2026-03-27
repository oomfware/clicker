/** raw Chrome event for the mutation queue */
export type TabIntent =
	| { type: 'tab-created'; tab: chrome.tabs.Tab }
	| { type: 'tab-removed'; tabId: number }
	| { type: 'tab-updated'; tabId: number; url?: string; title?: string; groupId?: number }
	| { type: 'tab-activated'; tabId: number }
	| { type: 'group-updated'; groupId: number; title: string; color: string }
	| { type: 'group-removed'; groupId: number };

/** registers Chrome event listeners and emits intents for the mutation queue */
export const startTabTracker = (onIntent: (intent: TabIntent) => void): void => {
	chrome.tabs.onCreated.addListener((tab) => {
		if (!tab.id || !tab.openerTabId) return;
		onIntent({ type: 'tab-created', tab });
	});

	chrome.tabs.onRemoved.addListener((tabId) => {
		onIntent({ type: 'tab-removed', tabId });
	});

	chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
		if (changeInfo.url || changeInfo.title || changeInfo.groupId !== undefined) {
			onIntent({
				type: 'tab-updated',
				tabId,
				url: changeInfo.url,
				title: changeInfo.title,
				groupId: changeInfo.groupId,
			});
		}
	});

	chrome.tabs.onActivated.addListener(({ tabId }) => {
		onIntent({ type: 'tab-activated', tabId });
	});

	chrome.tabGroups.onUpdated.addListener((group) => {
		onIntent({
			type: 'group-updated',
			groupId: group.id,
			title: group.title ?? '',
			color: group.color,
		});
	});

	chrome.tabGroups.onRemoved.addListener((group) => {
		onIntent({ type: 'group-removed', groupId: group.id });
	});
};
