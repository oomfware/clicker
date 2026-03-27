import { createWorkspaceId, type Workspace, type WorkspaceTab } from '@oomfware/clicker-protocol';

const TAB_GROUP_COLORS = ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan'] as const;

type TabGroupColor = (typeof TAB_GROUP_COLORS)[number];

const randomTabGroupColor = (): TabGroupColor =>
	TAB_GROUP_COLORS[Math.floor(Math.random() * TAB_GROUP_COLORS.length)];

/** resolves a Chrome tab group color string to a known color, defaulting to grey */
export const resolveTabGroupColor = (color: string): TabGroupColor => {
	/* oxlint-disable no-unsafe-type-assertion -- narrowed by includes() */
	return (TAB_GROUP_COLORS as readonly string[]).includes(color) ? (color as TabGroupColor) : 'grey';
	/* oxlint-enable no-unsafe-type-assertion */
};

const GROUP_TITLE_PREFIX = 'clicker (';

const formatGroupTitle = (title: string): string => `${GROUP_TITLE_PREFIX}${title})`;

/** extracts the workspace name from a tab group title, or null if not a clicker group */
export const parseGroupTitle = (title: string): string | null => {
	if (!title.startsWith(GROUP_TITLE_PREFIX) || !title.endsWith(')')) return null;
	return title.slice(GROUP_TITLE_PREFIX.length, -1);
};

const toWorkspaceTab = (tab: chrome.tabs.Tab): WorkspaceTab => ({
	tabId: tab.id!,
	url: tab.url ?? '',
	title: tab.title ?? '',
	active: tab.active,
});

export class WorkspaceManager {
	#workspaces = new Map<string, { workspace: Workspace; groupId: number; color: TabGroupColor }>();
	#tabToWorkspace = new Map<number, string>();
	#groupToWorkspace = new Map<number, string>();
	#pendingGroupAdoptions = new Set<number>();

	/** discovers existing clicker tab groups and builds the workspace map */
	async discover(): Promise<void> {
		const groups = await chrome.tabGroups.query({});
		const clickerGroups = groups.filter((g) => parseGroupTitle(g.title ?? '') !== null);

		const tabResults = await Promise.all(
			clickerGroups.map((group) => chrome.tabs.query({ groupId: group.id })),
		);

		for (let i = 0; i < clickerGroups.length; i++) {
			const group = clickerGroups[i];
			const name = parseGroupTitle(group.title ?? '')!;
			const workspaceTabs = tabResults[i].filter((t) => t.id !== undefined).map(toWorkspaceTab);

			const id = createWorkspaceId();
			const color = resolveTabGroupColor(group.color ?? 'grey');
			const workspace: Workspace = { id, title: name, tabs: workspaceTabs };
			this.#workspaces.set(id, { workspace, groupId: group.id, color });
			this.#groupToWorkspace.set(group.id, id);
			for (const tab of workspaceTabs) {
				this.#tabToWorkspace.set(tab.tabId, id);
			}
		}
	}

	async create(title: string, color: TabGroupColor = randomTabGroupColor()): Promise<Workspace> {
		const id = createWorkspaceId();
		const tab = await chrome.tabs.create({ url: 'about:blank', active: false });
		if (!tab.id) throw new Error('chrome.tabs.create returned a tab without an id');

		let groupId: number;
		try {
			groupId = await chrome.tabs.group({ tabIds: [tab.id] });
		} catch (err) {
			await chrome.tabs.remove(tab.id).catch(() => {});
			throw err;
		}

		// pre-register so the tab tracker's onUpdated handler sees this group
		// as tracked and won't race to adopt it
		this.#groupToWorkspace.set(groupId, id);
		try {
			await chrome.tabGroups.update(groupId, { title: formatGroupTitle(title), color });
		} catch (err) {
			this.#groupToWorkspace.delete(groupId);
			await chrome.tabs.remove(tab.id).catch(() => {});
			throw err;
		}

		const workspace: Workspace = { id, title, tabs: [toWorkspaceTab(tab)] };
		this.#workspaces.set(id, { workspace, groupId, color });
		this.#tabToWorkspace.set(tab.id, id);
		return workspace;
	}

	/**
	 * creates a new workspace from an existing tab, grouping it instead of
	 * opening about:blank
	 * @param tab the tab to build the workspace around
	 * @param title workspace title
	 * @returns the created workspace
	 * @throws if the tab has no id, is already tracked, or is in a non-clicker group
	 */
	async createFromTab(tab: chrome.tabs.Tab, title: string): Promise<Workspace> {
		if (!tab.id) throw new Error('tab has no id');
		if (this.#tabToWorkspace.has(tab.id)) throw new Error('tab is already in a workspace');
		if (tab.groupId !== undefined && tab.groupId >= 0 && !this.#groupToWorkspace.has(tab.groupId)) {
			throw new Error('tab is already in a non-clicker group');
		}

		const id = createWorkspaceId();
		const color = randomTabGroupColor();
		const groupId = await chrome.tabs.group({ tabIds: [tab.id] });
		// pre-register so the tab tracker's onUpdated handler sees this group
		// as tracked and won't race to adopt it
		this.#groupToWorkspace.set(groupId, id);
		try {
			await chrome.tabGroups.update(groupId, { title: formatGroupTitle(title), color });
		} catch (err) {
			this.#groupToWorkspace.delete(groupId);
			throw err;
		}

		const workspace: Workspace = { id, title, tabs: [toWorkspaceTab(tab)] };
		this.#workspaces.set(id, { workspace, groupId, color });
		this.#tabToWorkspace.set(tab.id, id);
		return workspace;
	}

	async destroy(workspaceId: string): Promise<boolean> {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return false;

		const tabIds = entry.workspace.tabs.map((t) => t.tabId);
		try {
			if (tabIds.length > 0) {
				await this.#ensureWindowSurvives(tabIds);
				await chrome.tabs.remove(tabIds);
			} else {
				await this.#removeEmptyGroup(entry.groupId);
			}
		} finally {
			for (const tabId of tabIds) {
				this.#tabToWorkspace.delete(tabId);
			}
			this.#groupToWorkspace.delete(entry.groupId);
			this.#workspaces.delete(workspaceId);
		}
		return true;
	}

	async createTab(workspaceId: string, url: string, active: boolean): Promise<WorkspaceTab> {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry) throw new Error(`workspace ${workspaceId} not found`);

		const tab = await chrome.tabs.create({ url, active });
		if (!tab.id) throw new Error('chrome.tabs.create returned a tab without an id');

		const existingWorkspaceId = this.#tabToWorkspace.get(tab.id);
		if (existingWorkspaceId === workspaceId) {
			if (active) {
				this.#markActiveTab(workspaceId, tab.id);
			}
			return (
				entry.workspace.tabs.find((workspaceTab) => workspaceTab.tabId === tab.id) ?? toWorkspaceTab(tab)
			);
		}
		if (existingWorkspaceId) {
			throw new Error(`tab ${tab.id} was added to a different workspace`);
		}

		try {
			await chrome.tabs.group({ tabIds: [tab.id], groupId: entry.groupId });
		} catch (err) {
			await chrome.tabs.remove(tab.id).catch(() => {});
			throw err;
		}

		const workspaceTab = toWorkspaceTab(tab);
		entry.workspace.tabs.push(workspaceTab);
		this.#tabToWorkspace.set(tab.id, workspaceId);
		if (active) {
			this.#markActiveTab(workspaceId, tab.id);
		}
		return workspaceTab;
	}

	async activateTab(workspaceId: string, tabId: number): Promise<boolean> {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry || this.#tabToWorkspace.get(tabId) !== workspaceId) return false;

		await chrome.tabs.update(tabId, { active: true });
		this.#markActiveTab(workspaceId, tabId);
		return true;
	}

	async closeTab(workspaceId: string, tabId: number): Promise<boolean> {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry || this.#tabToWorkspace.get(tabId) !== workspaceId) return false;

		await chrome.tabs.remove(tabId);
		return true;
	}

	list(): Workspace[] {
		return Array.from(this.#workspaces.values(), (e) => e.workspace);
	}

	get(workspaceId: string): Workspace | undefined {
		return this.#workspaces.get(workspaceId)?.workspace;
	}

	findByTabId(tabId: number): string | undefined {
		return this.#tabToWorkspace.get(tabId);
	}

	findByGroupId(groupId: number): string | undefined {
		return this.#groupToWorkspace.get(groupId);
	}

	async addTab(workspaceId: string, tab: chrome.tabs.Tab): Promise<boolean> {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry || !tab.id) return false;

		if (this.#tabToWorkspace.has(tab.id)) return false;

		await chrome.tabs.group({ tabIds: [tab.id], groupId: entry.groupId });

		entry.workspace.tabs.push(toWorkspaceTab(tab));
		this.#tabToWorkspace.set(tab.id, workspaceId);
		if (tab.active) {
			this.#markActiveTab(workspaceId, tab.id);
		}
		return true;
	}

	async removeTab(tabId: number): Promise<{ workspaceId: string; workspaceRemoved: boolean } | undefined> {
		const workspaceId = this.#tabToWorkspace.get(tabId);
		if (!workspaceId) return undefined;

		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return undefined;

		entry.workspace.tabs = entry.workspace.tabs.filter((t) => t.tabId !== tabId);
		this.#tabToWorkspace.delete(tabId);

		let workspaceRemoved = false;
		if (entry.workspace.tabs.length === 0) {
			this.#groupToWorkspace.delete(entry.groupId);
			this.#workspaces.delete(workspaceId);
			workspaceRemoved = true;
		}

		return { workspaceId, workspaceRemoved };
	}

	updateTab(tabId: number, url?: string, title?: string): void {
		const workspaceId = this.#tabToWorkspace.get(tabId);
		if (!workspaceId) return;

		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return;

		const tab = entry.workspace.tabs.find((t) => t.tabId === tabId);
		if (tab) {
			if (url !== undefined) tab.url = url;
			if (title !== undefined) tab.title = title;
		}
	}

	setTabActive(tabId: number, active: boolean): void {
		if (!active) return;
		const workspaceId = this.#tabToWorkspace.get(tabId);
		if (!workspaceId) return;
		this.#markActiveTab(workspaceId, tabId);
	}

	// #region tab group events

	/**
	 * adopts a tab group as a workspace when its title matches the clicker prefix.
	 * returns the new workspace or null if the group has no tabs.
	 */
	async adoptGroup(groupId: number, title: string, color: TabGroupColor): Promise<Workspace | null> {
		if (this.#groupToWorkspace.has(groupId) || this.#pendingGroupAdoptions.has(groupId)) return null;

		// guards against concurrent onUpdated events (e.g. Ctrl+Shift+T restore
		// fires multiple times before the first adoption completes). metadata and
		// tab membership changes during the window are not reconciled — acceptable
		// because restore events carry identical state and the window is <1 tick.
		this.#pendingGroupAdoptions.add(groupId);
		try {
			const tabs = await chrome.tabs.query({ groupId });
			const workspaceTabs = tabs.filter((t) => t.id !== undefined).map(toWorkspaceTab);
			if (workspaceTabs.length === 0) return null;

			const id = createWorkspaceId();
			const workspace: Workspace = { id, title, tabs: workspaceTabs };
			this.#workspaces.set(id, { workspace, groupId, color });
			this.#groupToWorkspace.set(groupId, id);
			for (const tab of workspaceTabs) {
				this.#tabToWorkspace.set(tab.tabId, id);
			}
			return workspace;
		} finally {
			this.#pendingGroupAdoptions.delete(groupId);
		}
	}

	/**
	 * disowns a workspace when its tab group title no longer matches the clicker prefix.
	 * returns the removed workspace info or undefined if the group wasn't tracked.
	 */
	disownGroup(groupId: number): { workspaceId: string; tabIds: number[] } | undefined {
		const workspaceId = this.#groupToWorkspace.get(groupId);
		if (!workspaceId) return undefined;

		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return undefined;

		const tabIds = entry.workspace.tabs.map((t) => t.tabId);
		for (const tabId of tabIds) {
			this.#tabToWorkspace.delete(tabId);
		}
		this.#groupToWorkspace.delete(groupId);
		this.#workspaces.delete(workspaceId);
		return { workspaceId, tabIds };
	}

	/** updates workspace metadata when the tab group title or color changes */
	updateGroup(groupId: number, title: string, color: TabGroupColor): void {
		const workspaceId = this.#groupToWorkspace.get(groupId);
		if (!workspaceId) return;

		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return;

		entry.workspace.title = title;
		entry.color = color;
	}

	// #endregion

	/**
	 * removes an empty Chrome tab group by temporarily adding a tab to it
	 * and then closing that tab. Chrome has no direct group-removal API, so
	 * removing the last tab in a group is the only way to delete it.
	 */
	async #removeEmptyGroup(groupId: number): Promise<void> {
		try {
			const tab = await chrome.tabs.create({ active: false });
			if (tab.id) {
				await chrome.tabs.group({ tabIds: [tab.id], groupId });
				await chrome.tabs.remove(tab.id);
			}
		} catch {
			// group may already be gone
		}
	}

	/**
	 * creates a sacrificial tab when removing `tabIds` would close the browser's
	 * only remaining window (all tabs gone → Chrome shuts down the profile).
	 * no-ops when multiple windows are open or other tabs would survive.
	 */
	async #ensureWindowSurvives(tabIds: number[]): Promise<void> {
		const windows = await chrome.windows.getAll({ populate: true });
		const normalWindows = windows.filter((w) => w.type === 'normal');
		if (normalWindows.length !== 1) return;

		const window = normalWindows[0];
		const removing = new Set(tabIds);
		if (window.tabs?.some((t) => t.id !== undefined && !removing.has(t.id))) return;

		await chrome.tabs.create({ windowId: window.id, active: false });
	}

	#markActiveTab(workspaceId: string, activeTabId: number): void {
		const entry = this.#workspaces.get(workspaceId);
		if (!entry) return;
		for (const tab of entry.workspace.tabs) {
			tab.active = tab.tabId === activeTabId;
		}
	}
}
