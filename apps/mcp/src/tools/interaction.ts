import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { SessionState } from '../session.ts';

import {
	CDP_MODIFIER_CTRL,
	CDP_MODIFIER_META,
	dispatchClick,
	dispatchDrag,
	includeSnapshotSchema,
	maybeSnapshot,
	notConnectedError,
	refreshRefInPlace,
	resolveNodeToObjectId,
	resolveRefEntry,
	resolveRefToRemoteObject,
	tryGetBoxModel,
	waitForStabilization,
	type TextContent,
} from './shared.ts';

// #region element resolution

/** checks if a point is within the current viewport */
const isInViewport = async (
	relay: RelayConnection,
	session: SessionState,
	x: number,
	y: number,
): Promise<boolean> => {
	try {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
			expression: '[window.innerWidth, window.innerHeight]',
			returnByValue: true,
		})) as { result: { value: [number, number] } };
		const [w, h] = result.result.value;
		return x >= 0 && x <= w && y >= 0 && y <= h;
	} catch {
		return true;
	}
};

/**
 * gets the clickable center coordinates of an element, with auto-scroll if off-screen.
 * if the cached `backendDOMNodeId` is stale (e.g. after a React re-render), the ref is
 * refreshed in place via the accessibility tree — only the one entry is updated, the
 * rest of the ref map is preserved.
 *
 * @returns coordinates and whether auto-scroll was performed
 */
const resolveRefToPoint = async (
	ref: string,
	relay: RelayConnection,
	session: SessionState,
): Promise<{ x: number; y: number; scrolled: boolean; frameId?: string }> => {
	const entry = resolveRefEntry(session, ref);
	const frameId = entry.frameId;

	let resolved: { nodeId: number; point: { x: number; y: number } } | null = null;
	if (entry.backendDOMNodeId) {
		const p = await tryGetBoxModel(relay, session, entry.backendDOMNodeId, frameId);
		if (p) resolved = { nodeId: entry.backendDOMNodeId, point: p };
	}
	if (!resolved) {
		const fresh = await refreshRefInPlace(relay, session, ref);
		const p = await tryGetBoxModel(relay, session, fresh.backendDOMNodeId, frameId);
		if (!p) {
			throw new Error(
				`Element for ref "${ref}" was relocated but has no box (likely hidden or detached mid-resolve). Run snapshot() to refresh.`,
			);
		}
		resolved = { nodeId: fresh.backendDOMNodeId, point: p };
	}
	const { nodeId, point } = resolved;

	const inView = await isInViewport(relay, session, point.x, point.y);
	if (!inView) {
		const objectId = await resolveNodeToObjectId(relay, session, nodeId, frameId);
		await sendCdpCommand(
			relay,
			session,
			'Runtime.callFunctionOn',
			{
				functionDeclaration: `function() { this.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }`,
				objectId,
			},
			{ frameId },
		);
		const updated = await tryGetBoxModel(relay, session, nodeId, frameId);
		if (updated) {
			session.setLastInteractedFrameId(frameId);
			return { ...updated, scrolled: true, frameId };
		}
	}

	session.setLastInteractedFrameId(frameId);
	return { ...point, scrolled: false, frameId };
};

// #endregion

// #region key handling

// named key definitions: [code, windowsVirtualKeyCode, text (keyDown only)]
const NAMED_KEY_DEFS: Record<string, [string, number, string?]> = {
	Enter: ['Enter', 13, '\r'],
	Tab: ['Tab', 9, '\t'],
	Escape: ['Escape', 27],
	Backspace: ['Backspace', 8],
	Delete: ['Delete', 46],
	ArrowUp: ['ArrowUp', 38],
	ArrowDown: ['ArrowDown', 40],
	ArrowLeft: ['ArrowLeft', 37],
	ArrowRight: ['ArrowRight', 39],
	Home: ['Home', 36],
	End: ['End', 35],
	PageUp: ['PageUp', 33],
	PageDown: ['PageDown', 34],
	Insert: ['Insert', 45],
	F1: ['F1', 112],
	F2: ['F2', 113],
	F3: ['F3', 114],
	F4: ['F4', 115],
	F5: ['F5', 116],
	F6: ['F6', 117],
	F7: ['F7', 118],
	F8: ['F8', 119],
	F9: ['F9', 120],
	F10: ['F10', 121],
	F11: ['F11', 122],
	F12: ['F12', 123],
};

// US keyboard punctuation: char → [code, windowsVirtualKeyCode]
const PUNCTUATION_DEFS: Record<string, [string, number]> = {
	';': ['Semicolon', 186],
	':': ['Semicolon', 186],
	'=': ['Equal', 187],
	'+': ['Equal', 187],
	',': ['Comma', 188],
	'<': ['Comma', 188],
	'-': ['Minus', 189],
	_: ['Minus', 189],
	'.': ['Period', 190],
	'>': ['Period', 190],
	'/': ['Slash', 191],
	'?': ['Slash', 191],
	'`': ['Backquote', 192],
	'~': ['Backquote', 192],
	'[': ['BracketLeft', 219],
	'{': ['BracketLeft', 219],
	'\\': ['Backslash', 220],
	'|': ['Backslash', 220],
	']': ['BracketRight', 221],
	'}': ['BracketRight', 221],
	"'": ['Quote', 222],
	'"': ['Quote', 222],
};

/** resolves a key to its CDP [code, windowsVirtualKeyCode, text?] tuple */
const resolveKeyDef = (key: string): [string, number, string?] | undefined => {
	// named keys (Enter, Tab, ArrowUp, etc.)
	if (NAMED_KEY_DEFS[key]) return NAMED_KEY_DEFS[key];

	// space
	if (key === ' ') return ['Space', 32, ' '];

	if (key.length === 1) {
		const upper = key.toUpperCase();
		const lower = key.toLowerCase();

		// letters: a-z / A-Z
		if (lower >= 'a' && lower <= 'z') {
			const vk = upper.charCodeAt(0); // 65-90
			return [`Key${upper}`, vk, key];
		}

		// digits: 0-9
		if (key >= '0' && key <= '9') {
			return [`Digit${key}`, key.charCodeAt(0), key];
		}

		// punctuation
		const punct = PUNCTUATION_DEFS[key];
		if (punct) return [punct[0], punct[1], key];

		// unknown single char — return with text but no code/VK
		return undefined;
	}

	return undefined;
};

/** parses a key combo like "Control+A" into base key and modifier bitmask */
const parseKeyCombo = (input: string): { key: string; modifiers: number } => {
	const parts = input.split('+');
	const key = parts.pop()!;
	let modifiers = 0;
	for (const mod of parts) {
		switch (mod.toLowerCase()) {
			case 'alt':
				modifiers |= 1;
				break;
			case 'control':
			case 'ctrl':
				modifiers |= 2;
				break;
			case 'meta':
			case 'cmd':
			case 'command':
				modifiers |= 4;
				break;
			case 'shift':
				modifiers |= 8;
				break;
		}
	}
	return { key, modifiers };
};

/** sends a keyDown + keyUp pair with full CDP key properties */
const pressKey = async (
	relay: RelayConnection,
	session: SessionState,
	key: string,
	modifiers?: number,
	frameId?: string,
): Promise<void> => {
	const def = resolveKeyDef(key);
	const base: Record<string, unknown> = { key };
	if (def) {
		base.code = def[0];
		base.windowsVirtualKeyCode = def[1];
		base.nativeVirtualKeyCode = def[1];
	}
	if (modifiers) {
		base.modifiers = modifiers;
	}

	const hasCommandModifier = modifiers && modifiers & (CDP_MODIFIER_CTRL | CDP_MODIFIER_META);
	const text = hasCommandModifier ? undefined : (def?.[2] ?? (key.length === 1 ? key : undefined));

	await sendCdpCommand(
		relay,
		session,
		'Input.dispatchKeyEvent',
		{
			...base,
			type: 'keyDown',
			text,
		},
		{ frameId },
	);
	await sendCdpCommand(relay, session, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' }, { frameId });
};

/**
 * types text with proper handling of control characters.
 * splits on \\n, \\r, \\t — printable runs use Input.insertText,
 * control chars dispatch as key events.
 */
const typeText = async (
	relay: RelayConnection,
	session: SessionState,
	text: string,
	frameId?: string,
): Promise<void> => {
	const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const segments = normalized.split(/(\n|\t)/);
	for (const segment of segments) {
		if (segment === '\n') {
			// oxlint-disable-next-line no-await-in-loop -- sequential typing
			await pressKey(relay, session, 'Enter', undefined, frameId);
		} else if (segment === '\t') {
			// oxlint-disable-next-line no-await-in-loop -- sequential typing
			await pressKey(relay, session, 'Tab', undefined, frameId);
		} else if (segment.length > 0) {
			// oxlint-disable-next-line no-await-in-loop -- sequential typing
			await sendCdpCommand(relay, session, 'Input.insertText', { text: segment }, { frameId });
		}
	}
};

// #endregion

// #region checkbox/switch

/** idempotently sets a checkbox/switch to the desired state */
const setCheckedState = async (
	ref: string,
	desired: boolean,
	relay: RelayConnection,
	session: SessionState,
	includeSnapshot: boolean,
): Promise<{ content: TextContent[]; isError?: true }> => {
	if (!session.isConnected) return notConnectedError();
	const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);

	// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
	const current = (await sendCdpCommand(
		relay,
		session,
		'Runtime.callFunctionOn',
		{
			functionDeclaration: 'function() { return this.checked; }',
			objectId,
			returnByValue: true,
		},
		{ frameId },
	)) as { result: { value: boolean } };

	const alreadyCorrect = current.result.value === desired;
	if (!alreadyCorrect) {
		const { x, y, frameId: resolvedFrameId } = await resolveRefToPoint(ref, relay, session);
		await dispatchClick(relay, session, x, y, 1, 'left', resolvedFrameId);

		// re-resolve — React may swap the checkbox node on state change, invalidating the
		// objectId captured before the click
		const post = await resolveRefToRemoteObject(relay, session, ref);

		// verify the click actually changed the state
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const after = (await sendCdpCommand(
			relay,
			session,
			'Runtime.callFunctionOn',
			{
				functionDeclaration: 'function() { return this.checked; }',
				objectId: post.objectId,
				returnByValue: true,
			},
			{ frameId: post.frameId },
		)) as { result: { value: boolean } };

		// if coordinate-based click missed (e.g. hidden checkbox with custom styling), retry via JS
		if (after.result.value !== desired) {
			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: 'function() { this.click(); }',
					objectId: post.objectId,
				},
				{ frameId: post.frameId },
			);
		}
	}

	const verb = desired ? 'Checked' : 'Unchecked';
	const msg = alreadyCorrect ? `${ref} was already ${verb.toLowerCase()}.` : `${verb} ${ref}.`;
	const content: TextContent[] = [{ type: 'text', text: msg }];
	await maybeSnapshot(includeSnapshot, relay, session, content);
	return { content };
};

// #endregion

export const registerInteractionTools = (
	server: McpServer,
	relay: RelayConnection,
	session: SessionState,
): void => {
	server.registerTool(
		'click',
		{
			description: 'Click an element.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				double_click: z.boolean().default(false).describe('Double-click instead of single click'),
				button: z.enum(['left', 'right', 'middle']).default('left').describe('Mouse button to click'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, double_click, button, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { x, y, scrolled, frameId } = await resolveRefToPoint(ref, relay, session);
			await dispatchClick(relay, session, x, y, double_click ? 2 : 1, button, frameId);
			await waitForStabilization(relay, session);

			const label = double_click ? 'Double-clicked' : 'Clicked';
			const scrollNote = scrolled ? ' (auto-scrolled into view)' : '';

			const content: TextContent[] = [{ type: 'text', text: `${label} ${ref}${scrollNote}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'type',
		{
			description: 'Type into the focused element.',
			inputSchema: {
				text: z.string().describe('Text to type'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ text, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const frameId = session.lastInteractedFrameId;
			await typeText(relay, session, text, frameId);

			const content: TextContent[] = [{ type: 'text', text: `Typed "${text}".` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'fill',
		{
			description: 'Replace the current value of an editable element.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				value: z.string().describe('Text to fill in'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, value, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);

			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: `function() {
					this.focus();
					if ('value' in this) {
						if ('select' in this && typeof this.select === 'function') {
							this.select();
						}
						this.value = '';
						this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
					} else if (this.isContentEditable) {
						this.textContent = '';
					}
				}`,
					objectId,
				},
				{ frameId },
			);
			session.setLastInteractedFrameId(frameId);
			await sendCdpCommand(relay, session, 'Input.insertText', { text: value }, { frameId });

			// Input.insertText already fires input events natively;
			// dispatch change because browsers only fire it on blur, not programmatic insertion.
			// re-resolve the object — React components commonly swap the input node on every
			// keystroke, which would invalidate the pre-mutation objectId.
			const post = await resolveRefToRemoteObject(relay, session, ref);
			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: `function() {
					this.dispatchEvent(new Event('change', { bubbles: true }));
				}`,
					objectId: post.objectId,
				},
				{ frameId: post.frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Filled ${ref} with "${value}".` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'hover',
		{
			description: 'Move the pointer over an element.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { x, y, frameId } = await resolveRefToPoint(ref, relay, session);
			await sendCdpCommand(
				relay,
				session,
				'Input.dispatchMouseEvent',
				{ type: 'mouseMoved', x, y },
				{ frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Hovered over ${ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'press',
		{
			description: 'Send a key press or key combo.',
			inputSchema: {
				key: z.string().describe('Key or key combo'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ key: rawKey, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { key, modifiers } = parseKeyCombo(rawKey);
			await pressKey(relay, session, key, modifiers || undefined, session.lastInteractedFrameId);

			const content: TextContent[] = [{ type: 'text', text: `Pressed ${rawKey}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'check',
		{
			description: 'Turn a checkbox or switch on.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => setCheckedState(ref, true, relay, session, include_snapshot),
	);

	server.registerTool(
		'uncheck',
		{
			description: 'Turn a checkbox or switch off.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => setCheckedState(ref, false, relay, session, include_snapshot),
	);

	server.registerTool(
		'drag',
		{
			description: 'Drag one element onto another.',
			inputSchema: {
				from_ref: z.string().describe('Source element ref from snapshot()'),
				to_ref: z.string().describe('Target element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ from_ref, to_ref, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const from = await resolveRefToPoint(from_ref, relay, session);
			const to = await resolveRefToPoint(to_ref, relay, session);

			if (from.frameId !== to.frameId) {
				return {
					content: [
						{ type: 'text', text: `Cannot drag between different frames (${from_ref} and ${to_ref}).` },
					],
					isError: true,
				};
			}

			const frameId = from.frameId;
			await dispatchDrag(relay, session, from, to, 10, 10, frameId);

			await waitForStabilization(relay, session);

			const content: TextContent[] = [{ type: 'text', text: `Dragged ${from_ref} to ${to_ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'scroll_into_view',
		{
			description: 'Scroll an element into view.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);

			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: `function() { this.scrollIntoView({ block: 'center', inline: 'center' }); }`,
					objectId,
				},
				{ frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Scrolled ${ref} into view.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'focus',
		{
			description: 'Focus an element.',
			inputSchema: {
				ref: z.string().describe('Element ref from snapshot()'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);

			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: 'function() { this.focus(); }',
					objectId,
				},
				{ frameId },
			);
			session.setLastInteractedFrameId(frameId);

			const content: TextContent[] = [{ type: 'text', text: `Focused ${ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'upload_file',
		{
			description: 'Set files on a file input.',
			inputSchema: {
				ref: z.string().describe('File input ref from snapshot()'),
				path: z.string().describe('Absolute file path'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, path, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const { backendDOMNodeId, frameId } = await resolveRefToRemoteObject(relay, session, ref);
			await sendCdpCommand(
				relay,
				session,
				'DOM.setFileInputFiles',
				{
					files: [path],
					backendNodeId: backendDOMNodeId,
				},
				{ frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Uploaded "${path}" to ${ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);
};
