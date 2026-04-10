import { formatError, TOOL_TIMEOUT_DEFAULT } from '@oomfware/clicker-protocol';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { clampTimeout, sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { SessionState } from '../session.ts';

import {
	includeSnapshotSchema,
	maybeSnapshot,
	notConnectedError,
	resolveNodeToObjectId,
	resolveRefEntry,
	resolveRefToRemoteObject,
	tryGetBoxModel,
	waitForStabilization,
	type TextContent,
} from './shared.ts';

// #region polling helper

/** polls a JS expression via Runtime.evaluate until truthy, with timeout and error distinction */
const pollUntil = async (
	relay: RelayConnection,
	session: SessionState,
	expression: string,
	timeoutMs: number,
): Promise<{ matched: boolean; error?: string }> => {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			// oxlint-disable-next-line no-await-in-loop, no-unsafe-type-assertion -- intentional sequential polling; CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
				expression,
				returnByValue: true,
			})) as { result: { value: unknown } };

			if (result.result.value) {
				return { matched: true };
			}
		} catch (err) {
			return { matched: false, error: formatError(err) };
		}
		// oxlint-disable-next-line no-await-in-loop -- intentional sequential polling
		await new Promise((r) => setTimeout(r, 200));
	}
	return { matched: false };
};

// #endregion

/** formats scroll movement as a human-readable response */
const formatScrollMovement = (moved: [number, number]): string => {
	return moved[0] === 0 && moved[1] === 0
		? 'No movement; at scroll boundary.'
		: `Scrolled by (${moved[0]}, ${moved[1]}).`;
};

export const registerPageTools = (server: McpServer, relay: RelayConnection, session: SessionState): void => {
	// #region wait tools

	server.registerTool(
		'wait_for_text',
		{
			description: 'Wait for text to appear or disappear on the page.',
			inputSchema: {
				text: z.string().describe('Text to wait for'),
				condition: z
					.enum(['present', 'absent'])
					.default('present')
					.describe('Wait for the text to be present or absent'),
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ text, condition, timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const ms = clampTimeout(timeout);
			const negate = condition === 'absent';
			const check = `document.body?.textContent?.includes(${JSON.stringify(text)})`;
			const test = negate ? `!(${check})` : check;
			const verb = negate ? 'disappeared' : 'found';

			const { matched, error } = await pollUntil(relay, session, test, ms);
			if (error) {
				return {
					content: [{ type: 'text', text: `Error while waiting for text "${text}": ${error}` }],
					isError: true,
				};
			}
			if (matched) {
				return { content: [{ type: 'text', text: `Text "${text}" ${verb}.` }] };
			}
			return {
				content: [
					{
						type: 'text',
						text: `Timed out waiting for text "${text}" to ${negate ? 'disappear' : 'appear'}.`,
					},
				],
				isError: true,
			};
		},
	);

	server.registerTool(
		'wait_for_url',
		{
			description: 'Wait for the page URL to match or stop matching a substring.',
			inputSchema: {
				url: z.string().describe('URL substring to wait for'),
				condition: z
					.enum(['present', 'absent'])
					.default('present')
					.describe('Wait for the URL to match or stop matching'),
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ url, condition, timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const ms = clampTimeout(timeout);
			const negate = condition === 'absent';
			const check = `location.href.includes(${JSON.stringify(url)})`;
			const test = negate ? `!(${check})` : check;
			const verb = negate ? 'no longer matches' : 'matches';

			const { matched, error } = await pollUntil(relay, session, test, ms);
			if (error) {
				return {
					content: [{ type: 'text', text: `Error while waiting for URL "${url}": ${error}` }],
					isError: true,
				};
			}
			if (matched) {
				return { content: [{ type: 'text', text: `URL ${verb} "${url}".` }] };
			}
			return {
				content: [
					{
						type: 'text',
						text: `Timed out waiting for URL to ${negate ? 'stop matching' : 'match'} "${url}".`,
					},
				],
				isError: true,
			};
		},
	);

	server.registerTool(
		'wait_for_selector',
		{
			description:
				'Wait for a CSS selector to reach a specific state. Prefer wait_for_text for simple text checks.',
			inputSchema: {
				selector: z.string().describe('CSS selector to wait for'),
				state: z
					.enum(['attached', 'detached', 'visible', 'hidden'])
					.default('visible')
					.describe('Target state for the element'),
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ selector, state, timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const ms = clampTimeout(timeout);
			const sel = JSON.stringify(selector);

			let expression: string;
			switch (state) {
				case 'attached':
					expression = `document.querySelector(${sel}) !== null`;
					break;
				case 'detached':
					expression = `document.querySelector(${sel}) === null`;
					break;
				case 'visible':
					expression = `(() => {
						const el = document.querySelector(${sel});
						if (!el) return false;
						const r = el.getBoundingClientRect();
						const s = getComputedStyle(el);
						return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
					})()`;
					break;
				case 'hidden':
					expression = `(() => {
						const el = document.querySelector(${sel});
						if (!el) return true;
						const r = el.getBoundingClientRect();
						const s = getComputedStyle(el);
						return r.width === 0 || r.height === 0 || s.visibility === 'hidden' || s.display === 'none';
					})()`;
					break;
			}

			const { matched, error } = await pollUntil(relay, session, expression, ms);
			if (error) {
				return {
					content: [{ type: 'text', text: `Error while waiting for "${selector}": ${error}` }],
					isError: true,
				};
			}
			if (matched) {
				return { content: [{ type: 'text', text: `Selector "${selector}" is ${state}.` }] };
			}
			return {
				content: [{ type: 'text', text: `Timed out waiting for "${selector}" to become ${state}.` }],
				isError: true,
			};
		},
	);

	server.registerTool(
		'wait_for_function',
		{
			description:
				'Evaluate a JS expression repeatedly until it returns a truthy value. The expression should be side-effect free.',
			inputSchema: {
				expression: z.string().describe('JS expression to evaluate (should be side-effect free)'),
				timeout: z.number().default(TOOL_TIMEOUT_DEFAULT).describe('Timeout in milliseconds (1000-120000)'),
			},
		},
		async ({ expression, timeout }) => {
			if (!session.isConnected) return notConnectedError();
			const ms = clampTimeout(timeout);
			const { matched, error } = await pollUntil(relay, session, expression, ms);
			if (error) {
				return {
					content: [{ type: 'text', text: `Error while waiting: ${error}` }],
					isError: true,
				};
			}
			if (matched) {
				return { content: [{ type: 'text', text: 'Condition met.' }] };
			}
			return {
				content: [{ type: 'text', text: 'Timed out waiting for condition.' }],
				isError: true,
			};
		},
	);

	// #endregion

	// #region dialog

	server.registerTool(
		'handle_dialog',
		{
			description:
				'Accept, dismiss, or check the status of a browser dialog (alert, confirm, prompt, beforeunload).',
			inputSchema: {
				action: z
					.enum(['accept', 'dismiss', 'status'])
					.describe('Accept/dismiss the dialog, or check if one is pending'),
				prompt_text: z.string().optional().describe('Text to enter for prompt dialogs'),
			},
		},
		async ({ action, prompt_text }) => {
			if (!session.isConnected) return notConnectedError();
			if (action === 'status') {
				const dialog = session.getDialog();
				if (!dialog) {
					return { content: [{ type: 'text', text: 'No dialog pending.' }] };
				}
				return {
					content: [
						{
							type: 'text',
							text: `Pending ${dialog.type} dialog: "${dialog.message}"${dialog.defaultPrompt ? ` (default: "${dialog.defaultPrompt}")` : ''}`,
						},
					],
				};
			}

			try {
				await sendCdpCommand(relay, session, 'Page.handleJavaScriptDialog', {
					accept: action === 'accept',
					promptText: prompt_text,
				});
				session.clearDialog();
				return { content: [{ type: 'text', text: `Dialog ${action}ed.` }] };
			} catch (err) {
				return {
					content: [{ type: 'text', text: `No dialog to handle: ${formatError(err)}` }],
					isError: true,
				};
			}
		},
	);

	// #endregion

	// #region scroll

	server.registerTool(
		'scroll',
		{
			description:
				'Scroll the page or a specific element by pixel deltas. Positive delta_y scrolls content up (reveals below), negative scrolls content down. Use wheel=true for infinite-scroll pages.',
			inputSchema: {
				delta_x: z.number().default(0).describe('Horizontal scroll delta in pixels'),
				delta_y: z.number().default(0).describe('Vertical scroll delta in pixels'),
				ref: z.string().optional().describe('Ref of a scrollable element; scrolls the page if omitted'),
				wheel: z
					.boolean()
					.default(false)
					.describe('Dispatch mouse wheel events instead of JS scrollBy (triggers wheel listeners)'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ delta_x, delta_y, ref, wheel, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();

			const respond = async (text: string) => {
				const content: TextContent[] = [{ type: 'text', text }];
				await maybeSnapshot(include_snapshot, relay, session, content);
				return { content };
			};

			// resolve wheel target coordinates
			if (wheel) {
				let x: number;
				let y: number;
				if (ref) {
					const entry = resolveRefEntry(session, ref);
					const point = await tryGetBoxModel(relay, session, entry.backendDOMNodeId, entry.frameId);
					({ x, y } = point ?? { x: 0, y: 0 });
					await sendCdpCommand(
						relay,
						session,
						'Input.dispatchMouseEvent',
						{ type: 'mouseWheel', x, y, deltaX: delta_x, deltaY: delta_y },
						{ frameId: entry.frameId },
					);
				} else {
					// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
					const vp = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
						expression: '[window.innerWidth / 2, window.innerHeight / 2]',
						returnByValue: true,
					})) as { result: { value: [number, number] } };
					[x, y] = vp.result.value;
					await sendCdpCommand(relay, session, 'Input.dispatchMouseEvent', {
						type: 'mouseWheel',
						x,
						y,
						deltaX: delta_x,
						deltaY: delta_y,
					});
				}
				// wheel events don't report actual scroll displacement
				return respond(`Dispatched wheel event (${delta_x}, ${delta_y}).`);
			}

			// JS scrollBy with actual movement measurement
			if (ref) {
				const entry = resolveRefEntry(session, ref);
				const objectId = await resolveNodeToObjectId(relay, session, entry.backendDOMNodeId, entry.frameId);
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
				const result = (await sendCdpCommand(
					relay,
					session,
					'Runtime.callFunctionOn',
					{
						functionDeclaration: `function() {
							var bx = this.scrollLeft, by = this.scrollTop;
							this.scrollBy(${delta_x}, ${delta_y});
							return [this.scrollLeft - bx, this.scrollTop - by];
						}`,
						objectId,
						returnByValue: true,
					},
					{ frameId: entry.frameId },
				)) as { result: { value: [number, number] } };
				return respond(formatScrollMovement(result.result.value));
			}

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
				expression: `(function() {
					var bx = window.scrollX, by = window.scrollY;
					window.scrollBy(${delta_x}, ${delta_y});
					return [window.scrollX - bx, window.scrollY - by];
				})()`,
				returnByValue: true,
			})) as { result: { value: [number, number] } };
			return respond(formatScrollMovement(result.result.value));
		},
	);

	// #endregion

	// #region select

	server.registerTool(
		'select',
		{
			description: 'Select an option in a dropdown (<select> element) by its ref.',
			inputSchema: {
				ref: z.string().describe('Ref of the select element'),
				value: z.string().optional().describe('Option value to select'),
				label: z.string().optional().describe('Option label (visible text) to select'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, value, label, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			if (!value && !label) {
				return { content: [{ type: 'text', text: 'Provide value or label.' }], isError: true };
			}

			const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);

			const setter =
				value !== undefined
					? `{
							const previousValue = this.value;
							this.value = ${JSON.stringify(value)};
							if (this.value !== ${JSON.stringify(value)}) return false;
							if (this.value !== previousValue) {
								this.dispatchEvent(new Event('input', { bubbles: true }));
								this.dispatchEvent(new Event('change', { bubbles: true }));
							}
							return true;
						}`
					: `{
							const opt = Array.from(this.options).find(o => o.text === ${JSON.stringify(label)});
							if (!opt) return false;
							const previousValue = this.value;
							this.value = opt.value;
							if (this.value !== previousValue) {
								this.dispatchEvent(new Event('input', { bubbles: true }));
								this.dispatchEvent(new Event('change', { bubbles: true }));
							}
							return true;
						}`;

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: `function() ${setter}`,
					objectId,
					returnByValue: true,
				},
				{ frameId },
			)) as { result?: { value?: boolean } };
			if (result.result?.value !== true) {
				const desc = value ? `value "${value}"` : `label "${label}"`;
				return {
					content: [{ type: 'text', text: `No option matched ${desc} on ${ref}.` }],
					isError: true,
				};
			}

			await waitForStabilization(relay, session);

			const desc = value ? `value "${value}"` : `label "${label}"`;
			const content: TextContent[] = [{ type: 'text', text: `Selected ${desc} on ${ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);
			return { content };
		},
	);

	// #endregion

	// #region console

	server.registerTool(
		'console',
		{
			description: 'Read buffered browser console messages and JS errors.',
			inputSchema: {
				tab_id: z.number().optional().describe('Tab ID to read from (defaults to active tab)'),
				level: z
					.enum(['all', 'log', 'warn', 'error', 'info', 'debug'])
					.default('all')
					.describe('Filter by console message level'),
				clear: z.boolean().default(false).describe('Clear the buffer after reading'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ tab_id, level, clear }) => {
			if (!session.isConnected) return notConnectedError();
			const messages = session.getConsoleMessages(tab_id, level === 'all' ? undefined : level);
			const errors = session.getJsErrors(tab_id);

			const lines: string[] = [];
			if (messages.length > 0) {
				lines.push('Console messages:');
				for (const msg of messages) {
					const src = msg.url ? ` — ${msg.url}` : '';
					lines.push(`  [${msg.level}] ${msg.text}${src}`);
				}
			}
			if (errors.length > 0) {
				if (lines.length > 0) lines.push('');
				lines.push('JS errors:');
				for (const err of errors) {
					const pos =
						err.line !== undefined
							? `line ${err.line}${err.column !== undefined ? `:${err.column}` : ''}`
							: '';
					const loc =
						err.url && pos ? ` (${err.url} ${pos})` : err.url ? ` (${err.url})` : pos ? ` (${pos})` : '';
					lines.push(`  ${err.text}${loc}`);
				}
			}

			if (lines.length === 0) {
				lines.push('No console messages or errors.');
			}

			if (clear) {
				session.clearConsole(tab_id);
				session.clearErrors(tab_id);
			}

			return { content: [{ type: 'text', text: lines.join('\n') }] };
		},
	);

	// #endregion
};
