import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { NetworkRequest, ResourceTiming, SessionState } from '../session.ts';

import { notConnectedError } from './shared.ts';

// #region timing computation

/** computed timing phases in milliseconds (-1 = not applicable) */
interface RequestTiming {
	blocked: number;
	dns: number;
	connect: number;
	ssl: number;
	send: number;
	wait: number;
	receive: number;
	total: number;
}

/**
 * computes additive timing phases from raw CDP ResourceTiming.
 * follows HAR 1.2 phase semantics; connect excludes ssl to avoid double-counting.
 * @param timing raw CDP ResourceTiming from Network.responseReceived
 * @param endTimestamp monotonic timestamp (seconds) from Network.loadingFinished or loadingFailed
 * @returns computed timing phases, or undefined if timing data is unavailable
 */
const computeRequestTiming = (
	timing: ResourceTiming | undefined,
	endTimestamp: number | undefined,
): RequestTiming | undefined => {
	if (!timing) return undefined;

	const {
		requestTime,
		dnsStart,
		dnsEnd,
		connectStart,
		connectEnd,
		sslStart,
		sslEnd,
		sendStart,
		sendEnd,
		receiveHeadersEnd,
	} = timing;

	const dns = dnsStart >= 0 && dnsEnd >= 0 ? dnsEnd - dnsStart : -1;
	const rawConnect = connectStart >= 0 && connectEnd >= 0 ? connectEnd - connectStart : -1;
	const ssl = sslStart >= 0 && sslEnd >= 0 ? sslEnd - sslStart : -1;
	// subtract ssl from connect to avoid double-counting
	const connect = rawConnect >= 0 && ssl >= 0 ? rawConnect - ssl : rawConnect;
	const send = sendStart >= 0 && sendEnd >= 0 ? Math.max(sendEnd - sendStart, 0) : 0;

	// wait = send end → headers fully received (includes header transfer time)
	const wait = sendEnd >= 0 && receiveHeadersEnd >= sendEnd ? receiveHeadersEnd - sendEnd : 0;

	// receive = headers done → loading finished/failed
	const receive =
		endTimestamp !== undefined && requestTime >= 0 && receiveHeadersEnd >= 0
			? Math.max((endTimestamp - requestTime - receiveHeadersEnd / 1000) * 1000, 0)
			: -1;

	// blocked = time before the earliest networking phase
	const blocked = dnsStart > 0 ? dnsStart : connectStart > 0 ? connectStart : sendStart > 0 ? sendStart : -1;

	const total =
		Math.max(blocked, 0) +
		Math.max(dns, 0) +
		Math.max(connect, 0) +
		Math.max(ssl, 0) +
		send +
		wait +
		Math.max(receive, 0);

	return { blocked, dns, connect, ssl, send, wait, receive, total };
};

/**
 * computes a total duration in ms for requests that lack ResourceTiming
 * (e.g. failed requests) using monotonic timestamps.
 */
const computeFallbackDuration = (req: NetworkRequest): number | undefined => {
	if (req.monotonicTimestamp === undefined) return undefined;
	const endTs = req.loadingFinishedTimestamp ?? req.loadingFailedTimestamp;
	if (endTs === undefined) return undefined;
	return Math.max((endTs - req.monotonicTimestamp) * 1000, 0);
};

/** formats timing phases as human-readable lines, omitting N/A phases */
const formatTiming = (t: RequestTiming): string => {
	const lines: string[] = [];
	const phase = (name: string, ms: number, label?: string) => {
		if (ms > 0) lines.push(`  ${name}: ${formatMs(ms)}${label ? ` (${label})` : ''}`);
	};
	phase('blocked', t.blocked);
	phase('dns', t.dns);
	phase('connect', t.connect);
	phase('ssl', t.ssl);
	phase('send', t.send);
	phase('wait', t.wait, 'TTFB');
	phase('receive', t.receive);
	lines.push(`  total: ${formatMs(t.total)}`);
	return lines.join('\n');
};

const formatMs = (ms: number): string => {
	if (ms < 1) return `${ms.toFixed(2)}ms`;
	if (ms < 1000) return `${ms.toFixed(1)}ms`;
	return `${(ms / 1000).toFixed(2)}s`;
};

// #endregion

const RESOURCE_TYPES = [
	'Document',
	'Stylesheet',
	'Image',
	'Media',
	'Font',
	'Script',
	'TextTrack',
	'XHR',
	'Fetch',
	'Prefetch',
	'EventSource',
	'WebSocket',
	'Manifest',
	'Ping',
	'Other',
] as const;

export const registerNetworkTools = (
	server: McpServer,
	relay: RelayConnection,
	session: SessionState,
): void => {
	server.registerTool(
		'list_network_requests',
		{
			description:
				'List captured network requests. Network capture is always active for the current tab.',
			inputSchema: {
				resource_type: z
					.enum(RESOURCE_TYPES)
					.optional()
					.describe('Filter by resource type'),
				status_code: z.number().optional().describe('Filter by exact HTTP status code'),
				url_contains: z.string().optional().describe('Filter by URL substring'),
				failed_only: z.boolean().default(false).describe('Show only failed requests'),
				min_duration_ms: z.number().optional().describe('Minimum request duration in ms'),
				page_size: z.number().default(50).describe('Maximum number of requests per page'),
				page_index: z.number().default(0).describe('Zero-based page index'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ resource_type, status_code, url_contains, failed_only, min_duration_ms, page_size, page_index }) => {
			if (!session.isConnected) return notConnectedError();

			let requests = session.getNetworkRequests();

			if (resource_type) {
				requests = requests.filter((r) => r.resourceType === resource_type);
			}
			if (status_code !== undefined) {
				requests = requests.filter((r) => r.status === status_code);
			}
			if (url_contains) {
				requests = requests.filter((r) => r.url.includes(url_contains));
			}
			if (failed_only) {
				requests = requests.filter((r) => r.failed);
			}
			if (min_duration_ms !== undefined) {
				requests = requests.filter((r) => {
					const t = computeRequestTiming(
						r.resourceTiming,
						r.loadingFinishedTimestamp ?? r.loadingFailedTimestamp,
					);
					const dur = t?.total ?? computeFallbackDuration(r);
					return dur !== undefined && dur >= min_duration_ms;
				});
			}

			const total = requests.length;
			const start = page_index * page_size;
			requests = requests.slice(start, start + page_size);

			if (requests.length === 0) {
				return { content: [{ type: 'text', text: total > 0 ? 'No requests on this page.' : 'No matching network requests captured.' }] };
			}

			const lines = requests.map((r) => {
				const status = r.failed
					? `FAILED${r.errorText ? ` (${r.errorText})` : ''}`
					: String(r.status ?? '...');
				const size = r.encodedDataLength !== undefined ? ` ${formatBytes(r.encodedDataLength)}` : '';
				const t = computeRequestTiming(
					r.resourceTiming,
					r.loadingFinishedTimestamp ?? r.loadingFailedTimestamp,
				);
				const dur = t?.total ?? computeFallbackDuration(r);
				const duration = dur !== undefined ? ` ${formatMs(dur)}` : '';
				return `[${r.requestId}] ${r.method} ${status} ${r.url} (${r.resourceType}${size}${duration})`;
			});

			if (total > requests.length) {
				const totalPages = Math.ceil(total / page_size);
				lines.push(`\n(page ${page_index + 1}/${totalPages}, ${total} total requests)`);
			}

			return { content: [{ type: 'text', text: lines.join('\n') }] };
		},
	);

	server.registerTool(
		'get_network_request',
		{
			description: 'Get full details of a specific network request by its ID.',
			inputSchema: {
				request_id: z.string().describe('Request ID from list_network_requests output'),
				include_body: z.boolean().default(false).describe('Fetch and include the response body'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ request_id, include_body }) => {
			if (!session.isConnected) return notConnectedError();

			const req = session.getNetworkRequest(request_id);
			if (!req) {
				return {
					content: [{ type: 'text', text: `Request "${request_id}" not found in buffer.` }],
					isError: true,
				};
			}

			const lines: string[] = [];
			lines.push(`${req.method} ${req.url}`);
			lines.push(
				`Status: ${req.failed ? `FAILED (${req.errorText ?? 'unknown'})` : `${req.status ?? 'pending'} ${req.statusText ?? ''}`}`,
			);
			lines.push(`Type: ${req.resourceType}`);
			if (req.mimeType) lines.push(`MIME: ${req.mimeType}`);
			if (req.encodedDataLength !== undefined) lines.push(`Size: ${formatBytes(req.encodedDataLength)}`);

			{
				const t = computeRequestTiming(
					req.resourceTiming,
					req.loadingFinishedTimestamp ?? req.loadingFailedTimestamp,
				);
				if (t) {
					const flags: string[] = [];
					if (req.connectionReused) flags.push('connection reused');
					if (req.fromDiskCache) flags.push('disk cache');
					if (req.fromServiceWorker) flags.push('service worker');
					lines.push(`\nTiming${flags.length > 0 ? ` (${flags.join(', ')})` : ''}:`);
					lines.push(formatTiming(t));
				} else {
					const dur = computeFallbackDuration(req);
					if (dur !== undefined) {
						lines.push(`\nDuration: ${formatMs(dur)}`);
					}
				}
			}

			if (req.requestHeaders && Object.keys(req.requestHeaders).length > 0) {
				lines.push('\nRequest Headers:');
				for (const [k, v] of Object.entries(req.requestHeaders)) {
					lines.push(`  ${k}: ${v}`);
				}
			}

			if (req.postData) {
				lines.push(`\nRequest Body:\n${req.postData}`);
			}

			if (req.responseHeaders && Object.keys(req.responseHeaders).length > 0) {
				lines.push('\nResponse Headers:');
				for (const [k, v] of Object.entries(req.responseHeaders)) {
					lines.push(`  ${k}: ${v}`);
				}
			}

			if (include_body && !req.failed && req.status !== undefined) {
				try {
					// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
					const result = (await sendCdpCommand(relay, session, 'Network.getResponseBody', {
						requestId: request_id,
					})) as { body: string; base64Encoded: boolean };

					if (result.base64Encoded) {
						lines.push(`\nResponse Body: (base64, ${formatBytes(result.body.length)} encoded)`);
					} else {
						const body =
							result.body.length > 10_000 ? `${result.body.slice(0, 10_000)}\n... (truncated)` : result.body;
						lines.push(`\nResponse Body:\n${body}`);
					}
				} catch {
					lines.push('\nResponse Body: (unavailable — may have been evicted from browser cache)');
				}
			}

			return { content: [{ type: 'text', text: lines.join('\n') }] };
		},
	);
};

const formatBytes = (bytes: number): string => {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
};
