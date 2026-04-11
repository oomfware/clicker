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
			description: 'Get browser cookies for the current page or a specific URL.',
			inputSchema: {
				urls: z.array(z.string()).optional().describe('URLs to get cookies for (defaults to current page)'),
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
			description: 'Set a browser cookie.',
			inputSchema: {
				name: z.string().describe('Cookie name'),
				value: z.string().describe('Cookie value'),
				url: z.string().optional().describe('URL to associate the cookie with (defaults to current page)'),
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
							text: reasons
								? `Cookie "${name}" was not set: ${reasons}`
								: `Cookie "${name}" was not set.`,
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
			description:
				'Delete browser cookies by name. Requires at least a name. Use domain/url/path to narrow scope when multiple cookies share the same name.',
			inputSchema: {
				name: z.string().describe('Cookie name to delete'),
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

			// delete without partition key (handles unpartitioned cookies)
			await sendCdpCommand(relay, session, 'Network.deleteCookies', params);

			// also delete with a derived partition key to handle Chrome's
			// cookie partitioning — without this, cookies stored in a
			// partition silently survive the first delete
			let topLevelSite: string | undefined;
			if (url) {
				try {
					const u = new URL(url);
					topLevelSite = `${u.protocol}//${u.hostname}`;
				} catch {
					// invalid URL — skip partitioned delete
				}
			} else if (domain) {
				const host = domain.startsWith('.') ? domain.slice(1) : domain;
				topLevelSite = `https://${host}`;
			}

			if (topLevelSite) {
				await sendCdpCommand(relay, session, 'Network.deleteCookies', {
					...params,
					partitionKey: { topLevelSite, hasCrossSiteAncestor: false },
				});
			}

			return { content: [{ type: 'text', text: `Cookie "${name}" deleted.` }] };
		},
	);

	// #endregion

	// #region storage

	server.registerTool(
		'get_storage',
		{
			description: 'Read a value from localStorage or sessionStorage.',
			inputSchema: {
				key: z.string().optional().describe('Storage key to read (lists all keys if omitted)'),
				storage: z.enum(['local', 'session']).default('local').describe('Which storage to read from'),
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
			description: 'Write a value to localStorage or sessionStorage.',
			inputSchema: {
				key: z.string().describe('Storage key'),
				value: z.string().describe('Value to store'),
				storage: z.enum(['local', 'session']).default('local').describe('Which storage to write to'),
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
				landscape: z.boolean().default(false).describe('Use landscape orientation'),
				print_background: z.boolean().default(true).describe('Include background graphics'),
				scale: z.number().default(1).describe('Scale of the page rendering (0.1-2.0)'),
				paper_width: z.number().optional().describe('Paper width in inches (default 8.5)'),
				paper_height: z.number().optional().describe('Paper height in inches (default 11)'),
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
							uri: `data:application/pdf;base64,${result.data}`,
							mimeType: 'application/pdf',
							text: result.data,
						},
					},
				],
			};
		},
	);

	// #endregion
};
