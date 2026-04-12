import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { SessionState } from '../session.ts';

import { notConnectedError } from './shared.ts';

/** evaluates a JS expression and returns the value, or throws on exception */
const safeEvaluate = async (
	relay: RelayConnection,
	session: SessionState,
	expression: string,
): Promise<unknown> => {
	// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
	const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
		expression,
		returnByValue: true,
	})) as {
		result: { value?: unknown };
		exceptionDetails?: { text: string; exception?: { description?: string } };
	};

	if (result.exceptionDetails) {
		throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
	}
	return result.result.value;
};

export const registerWebTools = (server: McpServer, relay: RelayConnection, session: SessionState): void => {
	// #region cookies

	server.registerTool(
		'get_cookies',
		{
			description: 'List cookies.',
			inputSchema: {
				urls: z.array(z.string()).optional().describe('URLs to read from; defaults to the current page'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ urls }) => {
			if (!session.isConnected) return notConnectedError();

			const params: Record<string, unknown> = {};
			if (urls && urls.length > 0) {
				params.urls = urls;
			}

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Network.getCookies', params)) as {
				cookies: Array<{
					name: string;
					value: string;
					domain: string;
					path: string;
					expires: number;
					httpOnly: boolean;
					secure: boolean;
					sameSite: string;
				}>;
			};

			if (result.cookies.length === 0) {
				return { content: [{ type: 'text', text: 'No cookies found.' }] };
			}

			const lines = result.cookies.map((c) => {
				const flags = [c.httpOnly && 'httpOnly', c.secure && 'secure', c.sameSite !== 'None' && c.sameSite]
					.filter(Boolean)
					.join(', ');
				return `${c.name}=${c.value} (domain=${c.domain}, path=${c.path}${flags ? `, ${flags}` : ''})`;
			});

			return { content: [{ type: 'text', text: lines.join('\n') }] };
		},
	);

	server.registerTool(
		'set_cookie',
		{
			description: 'Set a cookie.',
			inputSchema: {
				name: z.string().describe('Cookie name'),
				value: z.string().describe('Cookie value'),
				url: z.string().optional().describe('Associated URL; defaults to the current page'),
				domain: z.string().optional().describe('Cookie domain'),
				path: z.string().optional().describe('Cookie path'),
				secure: z.boolean().optional().describe('Secure flag'),
				http_only: z.boolean().optional().describe('HttpOnly flag'),
				same_site: z.enum(['Strict', 'Lax', 'None']).optional().describe('SameSite attribute'),
				expires: z.number().optional().describe('Expiration as Unix timestamp in seconds'),
			},
		},
		async ({ name, value, url, domain, path, secure, http_only, same_site, expires }) => {
			if (!session.isConnected) return notConnectedError();

			const params: Record<string, unknown> = { name, value };
			if (url) params.url = url;
			if (domain) params.domain = domain;
			if (path) params.path = path;
			if (secure !== undefined) params.secure = secure;
			if (http_only !== undefined) params.httpOnly = http_only;
			if (same_site) params.sameSite = same_site;
			if (expires !== undefined) params.expires = expires;

			// if no url or domain provided, use the current page URL
			if (!url && !domain) {
				try {
					// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
					const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
						expression: 'location.href',
						returnByValue: true,
					})) as { result?: { value?: string } };
					if (result.result?.value) {
						params.url = result.result.value;
					}
				} catch {
					// fall through — CDP will use default behavior
				}
			}

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Network.setCookie', params)) as {
				success: boolean;
				blockedReasons?: string[];
				exemptionReason?: string;
			};
			if (!result.success) {
				const reasons = [
					...(result.blockedReasons ?? []),
					...(result.exemptionReason ? [result.exemptionReason] : []),
				].join(', ');
				return {
					content: [
						{
							type: 'text',
							text: reasons ? `Cookie "${name}" was not set: ${reasons}` : `Cookie "${name}" was not set.`,
						},
					],
					isError: true,
				};
			}
			return { content: [{ type: 'text', text: `Cookie "${name}" set.` }] };
		},
	);

	server.registerTool(
		'delete_cookies',
		{
			description: 'Delete matching cookies.',
			inputSchema: {
				name: z.string().describe('Cookie name'),
				url: z.string().optional().describe('URL scope for deletion'),
				domain: z.string().optional().describe('Domain scope for deletion'),
				path: z.string().optional().describe('Path scope for deletion'),
			},
		},
		async ({ name, url, domain, path }) => {
			if (!session.isConnected) return notConnectedError();

			const params: Record<string, unknown> = { name };
			if (url) params.url = url;
			if (domain) params.domain = domain;
			if (path) params.path = path;

			// verify what matches before deletion so the response reflects what this tool can actually observe.
			// this avoids claiming success for partitioned cookies we cannot target reliably without the exact key.
			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const before = (await sendCdpCommand(
				relay,
				session,
				'Network.getCookies',
				url ? { urls: [url] } : {},
			)) as {
				cookies: Array<{
					name: string;
					domain: string;
					path: string;
					partitionKey?: unknown;
				}>;
			};
			const matches = before.cookies.filter((cookie) => {
				if (cookie.name !== name) {
					return false;
				}
				if (domain !== undefined && cookie.domain !== domain) {
					return false;
				}
				if (path !== undefined && cookie.path !== path) {
					return false;
				}
				if (url) {
					try {
						const targetUrl = new URL(url);
						const host = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
						if (targetUrl.hostname !== host && !targetUrl.hostname.endsWith(`.${host}`)) {
							return false;
						}
						if (!targetUrl.pathname.startsWith(cookie.path)) {
							return false;
						}
					} catch {
						return false;
					}
				}
				return true;
			});

			if (matches.length === 0) {
				return {
					content: [{ type: 'text', text: `No matching cookies found for "${name}".` }],
					isError: true,
				};
			}

			const unpartitioned = matches.filter((cookie) => !cookie.partitionKey);
			const partitioned = matches.length - unpartitioned.length;

			await Promise.all(
				unpartitioned.map(async (cookie) => {
					await sendCdpCommand(relay, session, 'Network.deleteCookies', {
						name: cookie.name,
						domain: cookie.domain,
						path: cookie.path,
					});
				}),
			);

			const deleted = unpartitioned.length;
			if (deleted === matches.length) {
				return {
					content: [
						{ type: 'text', text: `Deleted ${deleted} cookie${deleted === 1 ? '' : 's'} named "${name}".` },
					],
				};
			}

			const warnings: string[] = [];
			if (deleted > 0) {
				warnings.push(`deleted ${deleted} unpartitioned cookie${deleted === 1 ? '' : 's'}`);
			}
			if (partitioned > 0) {
				warnings.push(
					`${partitioned} partitioned cookie${partitioned === 1 ? '' : 's'} may remain because Chrome requires the exact partition key to delete them`,
				);
			}
			return {
				content: [{ type: 'text', text: `${warnings.join('; ')}.` }],
				isError: true,
			};
		},
	);

	// #endregion

	// #region storage

	server.registerTool(
		'get_storage',
		{
			description: 'Read web storage.',
			inputSchema: {
				key: z.string().optional().describe('Storage key; omit to list all keys'),
				storage: z.enum(['local', 'session']).default('local').describe('Storage area'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ key, storage }) => {
			if (!session.isConnected) return notConnectedError();

			const storageObj = storage === 'session' ? 'sessionStorage' : 'localStorage';

			if (key === undefined) {
				const raw = await safeEvaluate(
					relay,
					session,
					`JSON.stringify(Object.fromEntries(Object.entries(${storageObj})))`,
				);

				if (typeof raw !== 'string' || raw === '{}') {
					return { content: [{ type: 'text', text: `${storageObj} is empty.` }] };
				}

				const entries = JSON.parse(raw);
				const lines = Object.entries(entries).map(([k, v]) => `${k}: ${String(v)}`);
				return { content: [{ type: 'text', text: lines.join('\n') }] };
			}

			const value = await safeEvaluate(relay, session, `${storageObj}.getItem(${JSON.stringify(key)})`);

			if (value === null || value === undefined) {
				return { content: [{ type: 'text', text: `Key "${key}" not found in ${storageObj}.` }] };
			}

			return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] };
		},
	);

	server.registerTool(
		'set_storage',
		{
			description: 'Write web storage.',
			inputSchema: {
				key: z.string().describe('Storage key'),
				value: z.string().describe('Value to store'),
				storage: z.enum(['local', 'session']).default('local').describe('Storage area'),
			},
		},
		async ({ key, value, storage }) => {
			if (!session.isConnected) return notConnectedError();

			const storageObj = storage === 'session' ? 'sessionStorage' : 'localStorage';
			await safeEvaluate(
				relay,
				session,
				`${storageObj}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
			);

			return { content: [{ type: 'text', text: `Set ${storageObj}["${key}"].` }] };
		},
	);

	// #endregion

	// #region PDF

	server.registerTool(
		'generate_pdf',
		{
			description: 'Generate a PDF of the current page.',
			inputSchema: {
				landscape: z.boolean().default(false).describe('Landscape orientation'),
				print_background: z.boolean().default(true).describe('Include background graphics'),
				scale: z.number().default(1).describe('Render scale'),
				paper_width: z.number().optional().describe('Paper width in inches'),
				paper_height: z.number().optional().describe('Paper height in inches'),
			},
		},
		async ({ landscape, print_background, scale, paper_width, paper_height }) => {
			if (!session.isConnected) return notConnectedError();

			const params: Record<string, unknown> = {
				landscape,
				printBackground: print_background,
				scale: Math.max(0.1, Math.min(2.0, scale)),
			};
			if (paper_width !== undefined) params.paperWidth = paper_width;
			if (paper_height !== undefined) params.paperHeight = paper_height;

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Page.printToPDF', params)) as { data: string };

			return {
				content: [
					{
						type: 'resource',
						resource: {
							uri: 'file://clicker/generated.pdf',
							mimeType: 'application/pdf',
							blob: result.data,
						},
					},
				],
			};
		},
	);

	// #endregion
};
