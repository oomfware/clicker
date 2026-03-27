export const DEFAULT_PORT = 52824;
export const PING_INTERVAL = 10_000;
export const RECONNECT_INTERVAL = 3_000;
export const REQUEST_TIMEOUT = 30_000;
export const RELAY_STARTUP_TIMEOUT = 5_000;
export const HANDSHAKE_TIMEOUT = 5_000;

/** wire protocol version, incremented on breaking changes to the message format */
export const PROTOCOL_VERSION = 1;

/** WebSocket close code: peer sent an incompatible protocol version */
export const WS_CLOSE_VERSION_MISMATCH = 4001;

/** WebSocket close code: peer failed to respond to pings */
export const WS_CLOSE_HEARTBEAT_TIMEOUT = 4002;

/** WebSocket close code: handshake rejected (reason in close reason string) */
export const WS_CLOSE_HANDSHAKE_REJECTED = 4003;

export const TOOL_TIMEOUT_DEFAULT = 10_000;
export const TOOL_TIMEOUT_MIN = 1_000;
export const TOOL_TIMEOUT_MAX = 120_000;

export const RESTRICTED_URL_PREFIXES = [
	'chrome://',
	'chrome-extension://',
	'chrome-untrusted://',
	'devtools://',
	'chrome-search://',
];

export const isRestrictedUrl = (url: string): boolean =>
	RESTRICTED_URL_PREFIXES.some((prefix) => url.startsWith(prefix));

/** extracts a message string from an unknown error value */
export const formatError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
