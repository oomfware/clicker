export interface RefEntry {
	ref: string;
	role: string;
	name: string;
	backendDOMNodeId?: number;
	frameId?: string;
	/**
	 * zero-based index among siblings matching this `(frameId, role, name)` tuple
	 * in the snapshot that produced this entry. used as a disambiguator when the
	 * cached `backendDOMNodeId` is stale and we need to re-locate the element via
	 * the accessibility tree.
	 */
	nth?: number;
}

export interface ConsoleMessage {
	timestamp: number;
	level: string;
	text: string;
	url?: string;
}

export interface JsError {
	timestamp: number;
	text: string;
	url?: string;
	line?: number;
	column?: number;
}

export interface DialogInfo {
	type: string;
	message: string;
	url?: string;
	defaultPrompt?: string;
}

/**
 * raw CDP ResourceTiming fields.
 * `requestTime` is a monotonic baseline in seconds; all other fields are ms offsets from it (-1 = N/A).
 */
export interface ResourceTiming {
	requestTime: number;
	dnsStart: number;
	dnsEnd: number;
	connectStart: number;
	connectEnd: number;
	sslStart: number;
	sslEnd: number;
	sendStart: number;
	sendEnd: number;
	receiveHeadersStart: number;
	receiveHeadersEnd: number;
}

export interface NetworkRequest {
	id: string;
	requestId: string;
	url: string;
	method: string;
	resourceType: string;
	/** tab that originated this request */
	tabId: number;
	requestHeaders?: Record<string, string>;
	postData?: string;
	timestamp: number;
	/** monotonic timestamp (seconds) from requestWillBeSent */
	monotonicTimestamp?: number;
	status?: number;
	statusText?: string;
	responseHeaders?: Record<string, string>;
	mimeType?: string;
	encodedDataLength?: number;
	failed?: boolean;
	errorText?: string;
	/** raw CDP ResourceTiming from Network.responseReceived */
	resourceTiming?: ResourceTiming;
	/** monotonic timestamp (seconds) from Network.loadingFinished */
	loadingFinishedTimestamp?: number;
	/** monotonic timestamp (seconds) from Network.loadingFailed */
	loadingFailedTimestamp?: number;
	connectionReused?: boolean;
	fromDiskCache?: boolean;
	fromServiceWorker?: boolean;
}

export interface EmulationState {
	width?: number;
	height?: number;
	deviceScaleFactor?: number;
	mobile?: boolean;
	touch?: boolean;
}

const MAX_CONSOLE_MESSAGES = 100;
const MAX_JS_ERRORS = 50;
const MAX_NETWORK_REQUESTS = 500;

/** fixed-capacity circular buffer with O(1) push and oldest-first iteration */
class RingBuffer<T> {
	readonly capacity: number;
	#items: T[] = [];
	#head = 0;

	constructor(capacity: number) {
		this.capacity = capacity;
	}

	push(item: T): void {
		if (this.#items.length < this.capacity) {
			this.#items.push(item);
		} else {
			// overwrite oldest, advance head
			this.#items[this.#head] = item;
			this.#head = (this.#head + 1) % this.capacity;
		}
	}

	/** returns items in insertion order (oldest first) */
	toArray(): T[] {
		if (this.#head === 0) return this.#items.slice();
		return [...this.#items.slice(this.#head), ...this.#items.slice(0, this.#head)];
	}

	get size(): number {
		return this.#items.length;
	}
}

/** tracks state for the current MCP session */
export class SessionState {
	// #region binding state (set on connect_workspace, cleared on disconnect)

	#workspaceId: string | null = null;
	#connectionId: string | null = null;

	get workspaceId(): string | null {
		return this.#workspaceId;
	}

	get connectionId(): string | null {
		return this.#connectionId;
	}

	get isConnected(): boolean {
		return this.#connectionId !== null && this.#workspaceId !== null;
	}

	// #endregion

	// #region tab selection (set on tab switch, preserved across navigation)

	#activeTabId: number | null = null;
	#lastInteractedFrameId: string | undefined = undefined;

	get activeTabId(): number | null {
		return this.#activeTabId;
	}

	get lastInteractedFrameId(): string | undefined {
		return this.#lastInteractedFrameId;
	}

	setLastInteractedFrameId(frameId: string | undefined): void {
		this.#lastInteractedFrameId = frameId;
	}

	// #endregion

	// #region per-tab runtime state

	#refMap = new Map<string, RefEntry>();
	#tabConsoleMessages = new Map<number, RingBuffer<ConsoleMessage>>();
	#tabJsErrors = new Map<number, RingBuffer<JsError>>();
	#tabDialogs = new Map<number, DialogInfo>();
	#networkRequests = new Map<string, NetworkRequest>();

	#networkRequestId(tabId: number, requestId: string): string {
		return `${tabId}:${requestId}`;
	}
	#emulationState: EmulationState = {};

	#resolveTabId(tabId?: number): number | null {
		return tabId ?? this.#activeTabId;
	}

	#clearPerTabState(): void {
		this.#tabConsoleMessages.clear();
		this.#tabJsErrors.clear();
		this.#tabDialogs.clear();
	}

	#deleteTabState(tabId: number): void {
		this.#tabConsoleMessages.delete(tabId);
		this.#tabJsErrors.delete(tabId);
		this.#tabDialogs.delete(tabId);
		this.clearNetworkRequests(tabId);
	}

	/** pushes an item into a per-tab ring buffer, overwriting the oldest entry at capacity */
	#bufferEntry<T>(map: Map<number, RingBuffer<T>>, tabId: number, entry: T, capacity: number): void {
		let buf = map.get(tabId);
		if (!buf) {
			buf = new RingBuffer(capacity);
			map.set(tabId, buf);
		}
		buf.push(entry);
	}

	// #endregion

	// #region transitions

	/**
	 * connects the session to a workspace. resets all transient state.
	 * use this for initial workspace connection or reconnection.
	 */
	connectWorkspace(connectionId: string, workspaceId: string, activeTabId?: number): void {
		this.#connectionId = connectionId;
		this.#workspaceId = workspaceId;
		this.#activeTabId = activeTabId ?? null;
		this.#lastInteractedFrameId = undefined;
		this.#refMap.clear();
		this.#clearPerTabState();
	}

	/**
	 * switches the selected tab. clears refs (DOM-specific) but preserves
	 * per-tab console, errors, and dialog state. no-ops when the tab is unchanged
	 * so same-tab re-activation events don't invalidate refs.
	 */
	selectTab(tabId: number | undefined): void {
		const next = tabId ?? null;
		if (next === this.#activeTabId) return;
		this.#activeTabId = next;
		this.#lastInteractedFrameId = undefined;
		this.#refMap.clear();
	}

	/**
	 * clears navigation-scoped state for a specific tab.
	 * refs are only cleared when the navigated tab is the active tab.
	 * no-ops if tabId is null (no tab selected).
	 */
	onNavigation(tabId: number | null): void {
		if (tabId === null) return;
		this.#deleteTabState(tabId);
		if (tabId === this.#activeTabId) {
			this.#refMap.clear();
			this.#lastInteractedFrameId = undefined;
		}
	}

	/** removes all per-tab state for a closed tab */
	removeTab(tabId: number): void {
		this.#deleteTabState(tabId);
	}

	/** disconnects the session. full state reset including network and emulation. */
	disconnect(): void {
		this.#connectionId = null;
		this.#workspaceId = null;
		this.#activeTabId = null;
		this.#lastInteractedFrameId = undefined;
		this.#refMap.clear();
		this.#clearPerTabState();
		this.#networkRequests.clear();
		this.#emulationState = {};
	}

	// #endregion

	// #region ref management

	setRefMap(entries: RefEntry[]): void {
		this.#refMap.clear();
		for (const entry of entries) {
			this.#refMap.set(entry.ref, entry);
		}
	}

	get refCount(): number {
		return this.#refMap.size;
	}

	resolveRef(ref: string): RefEntry | undefined {
		return this.#refMap.get(ref);
	}

	/**
	 * finds ref entries by role and name, scoped to a specific frame.
	 * returns all matches so callers can enforce uniqueness.
	 */
	findByRoleName(role: string, name: string, frameId?: string): RefEntry[] {
		const matches: RefEntry[] = [];
		for (const entry of this.#refMap.values()) {
			if (entry.role === role && entry.name === name && entry.frameId === frameId) {
				matches.push(entry);
			}
		}
		return matches;
	}

	// #endregion

	// #region console/error buffering

	addConsoleMessage(tabId: number, msg: ConsoleMessage): void {
		this.#bufferEntry(this.#tabConsoleMessages, tabId, msg, MAX_CONSOLE_MESSAGES);
	}

	addJsError(tabId: number, err: JsError): void {
		this.#bufferEntry(this.#tabJsErrors, tabId, err, MAX_JS_ERRORS);
	}

	getConsoleMessages(tabId?: number, level?: string): ConsoleMessage[] {
		const id = this.#resolveTabId(tabId);
		if (id === null) return [];
		const buf = this.#tabConsoleMessages.get(id);
		if (!buf) return [];
		const messages = buf.toArray();
		if (!level) return messages;
		return messages.filter((m) => m.level === level);
	}

	getJsErrors(tabId?: number): JsError[] {
		const id = this.#resolveTabId(tabId);
		if (id === null) return [];
		return this.#tabJsErrors.get(id)?.toArray() ?? [];
	}

	clearConsole(tabId?: number): void {
		const id = this.#resolveTabId(tabId);
		if (id !== null) this.#tabConsoleMessages.delete(id);
	}

	clearErrors(tabId?: number): void {
		const id = this.#resolveTabId(tabId);
		if (id !== null) this.#tabJsErrors.delete(id);
	}

	// #endregion

	// #region dialog tracking

	setDialog(tabId: number, dialog: DialogInfo): void {
		this.#tabDialogs.set(tabId, dialog);
	}

	clearDialog(tabId?: number): void {
		const id = this.#resolveTabId(tabId);
		if (id !== null) this.#tabDialogs.delete(id);
	}

	getDialog(tabId?: number): DialogInfo | null {
		const id = this.#resolveTabId(tabId);
		if (id === null) return null;
		return this.#tabDialogs.get(id) ?? null;
	}

	// #endregion

	// #region network monitoring

	/** records or updates a network request from CDP events */
	updateNetworkRequest(
		requestId: string,
		tabId: number,
		update: Partial<Omit<NetworkRequest, 'id' | 'requestId' | 'tabId'>>,
	): void {
		const id = this.#networkRequestId(tabId, requestId);
		const existing = this.#networkRequests.get(id);
		if (existing) {
			Object.assign(existing, update);
			return;
		}
		if (this.#networkRequests.size >= MAX_NETWORK_REQUESTS) {
			const firstKey = this.#networkRequests.keys().next().value;
			if (firstKey !== undefined) {
				this.#networkRequests.delete(firstKey);
			}
		}
		this.#networkRequests.set(id, {
			id,
			requestId,
			url: '',
			method: '',
			resourceType: '',
			tabId,
			timestamp: 0,
			...update,
		});
	}

	/** returns network requests, optionally filtered to a specific tab */
	getNetworkRequests(tabId?: number): NetworkRequest[] {
		const all = Array.from(this.#networkRequests.values());
		if (tabId === undefined) return all;
		return all.filter((r) => r.tabId === tabId);
	}

	getNetworkRequest(id: string): NetworkRequest | undefined {
		return this.#networkRequests.get(id);
	}

	clearNetworkRequests(tabId?: number): void {
		if (tabId === undefined) {
			this.#networkRequests.clear();
			return;
		}
		for (const [id, request] of this.#networkRequests) {
			if (request.tabId === tabId) {
				this.#networkRequests.delete(id);
			}
		}
	}

	// #endregion

	// #region emulation state

	get emulationState(): EmulationState {
		return { ...this.#emulationState };
	}

	/** merges provided fields into stored emulation state and returns the merged result */
	mergeEmulationState(update: Partial<EmulationState>): EmulationState {
		Object.assign(this.#emulationState, update);
		return { ...this.#emulationState };
	}

	clearEmulationState(): void {
		this.#emulationState = {};
	}

	// #endregion
}
