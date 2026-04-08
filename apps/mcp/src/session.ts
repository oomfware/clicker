export interface RefEntry {
	ref: string;
	role: string;
	name: string;
	backendDOMNodeId?: number;
	frameId?: string;
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
	#consoleMessages: ConsoleMessage[] = [];
	#jsErrors: JsError[] = [];
	#pendingDialog: DialogInfo | null = null;
	#networkEnabled = false;
	#networkRequests = new Map<string, NetworkRequest>();
	#emulationState: EmulationState = {};

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
		this.#resetTabState();
	}

	/**
	 * switches the selected tab without clearing console, errors, or network state.
	 * use this for tab activation events and explicit select_tab.
	 */
	selectTab(tabId: number | undefined): void {
		this.#activeTabId = tabId ?? null;
		this.#lastInteractedFrameId = undefined;
		this.#resetTabState();
	}

	/** clears navigation-scoped state (refs, console, errors). call after top-level navigations. */
	onNavigation(): void {
		this.#refMap.clear();
		this.#lastInteractedFrameId = undefined;
		this.#consoleMessages = [];
		this.#jsErrors = [];
		this.#pendingDialog = null;
	}

	/** disconnects the session. full state reset including network and emulation. */
	disconnect(): void {
		this.#connectionId = null;
		this.#workspaceId = null;
		this.#activeTabId = null;
		this.#lastInteractedFrameId = undefined;
		this.#resetTabState();
		this.#networkEnabled = false;
		this.#networkRequests.clear();
		this.#emulationState = {};
	}

	#resetTabState(): void {
		this.#refMap.clear();
		this.#consoleMessages = [];
		this.#jsErrors = [];
		this.#pendingDialog = null;
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

	addConsoleMessage(msg: ConsoleMessage): void {
		this.#consoleMessages.push(msg);
		if (this.#consoleMessages.length > MAX_CONSOLE_MESSAGES) {
			this.#consoleMessages.shift();
		}
	}

	addJsError(err: JsError): void {
		this.#jsErrors.push(err);
		if (this.#jsErrors.length > MAX_JS_ERRORS) {
			this.#jsErrors.shift();
		}
	}

	getConsoleMessages(level?: string): ConsoleMessage[] {
		if (!level) return [...this.#consoleMessages];
		return this.#consoleMessages.filter((m) => m.level === level);
	}

	getJsErrors(): JsError[] {
		return [...this.#jsErrors];
	}

	clearConsole(): void {
		this.#consoleMessages = [];
	}

	clearErrors(): void {
		this.#jsErrors = [];
	}

	// #endregion

	// #region dialog tracking

	setDialog(dialog: DialogInfo): void {
		this.#pendingDialog = dialog;
	}

	clearDialog(): void {
		this.#pendingDialog = null;
	}

	getDialog(): DialogInfo | null {
		return this.#pendingDialog;
	}

	// #endregion

	// #region network monitoring

	get networkEnabled(): boolean {
		return this.#networkEnabled;
	}

	setNetworkEnabled(enabled: boolean): void {
		this.#networkEnabled = enabled;
		if (!enabled) {
			this.#networkRequests.clear();
		}
	}

	/** records or updates a network request from CDP events */
	updateNetworkRequest(
		requestId: string,
		tabId: number,
		update: Partial<Omit<NetworkRequest, 'tabId'>>,
	): void {
		if (!this.#networkEnabled) return;

		const existing = this.#networkRequests.get(requestId);
		if (existing) {
			Object.assign(existing, update);
		} else {
			// evict oldest if at capacity
			if (this.#networkRequests.size >= MAX_NETWORK_REQUESTS) {
				const firstKey = this.#networkRequests.keys().next().value;
				if (firstKey !== undefined) {
					this.#networkRequests.delete(firstKey);
				}
			}
			this.#networkRequests.set(requestId, {
				requestId,
				url: '',
				method: '',
				resourceType: '',
				tabId,
				timestamp: 0,
				...update,
			});
		}
	}

	/** returns network requests, optionally filtered to a specific tab */
	getNetworkRequests(tabId?: number): NetworkRequest[] {
		const all = Array.from(this.#networkRequests.values());
		if (tabId === undefined) return all;
		return all.filter((r) => r.tabId === tabId);
	}

	getNetworkRequest(requestId: string): NetworkRequest | undefined {
		return this.#networkRequests.get(requestId);
	}

	clearNetworkRequests(): void {
		this.#networkRequests.clear();
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
