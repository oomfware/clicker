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
	resolveNodeToObjectId,
	resolveRefEntry,
	resolveRefToRemoteObject,
	tryGetBoxModel,
	waitForStabilization,
	type TextContent,
} from './shared.ts';
import { takeSnapshot } from './state.ts';

// #region element resolution

/**
 * re-queries the AX tree to find an element by role+name when the original node ID is stale.
 * note: takeSnapshot replaces the session ref map as a side effect — this is intentional
 * since the old refs are stale anyway.
 */
const fallbackResolve = async (
	relay: RelayConnection,
	session: SessionState,
	role: string,
	name: string,
	frameId?: string,
): Promise<{ x: number; y: number; backendDOMNodeId: number } | 'ambiguous' | null> => {
	await takeSnapshot(relay, session);
	const matches = session.findByRoleName(role, name, frameId);
	if (matches.length === 0 || !matches[0].backendDOMNodeId) return null;
	if (matches.length > 1) return 'ambiguous';
	const point = await tryGetBoxModel(relay, session, matches[0].backendDOMNodeId, frameId);
	if (!point) return null;
	return { ...point, backendDOMNodeId: matches[0].backendDOMNodeId };
};

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
 * gets the clickable center coordinates of an element, with auto-scroll if off-screen
 * and role+name fallback if the node is stale.
 * @returns coordinates and whether auto-scroll was performed
 */
const resolveRefToPoint = async (
	ref: string,
	relay: RelayConnection,
	session: SessionState,
): Promise<{ x: number; y: number; scrolled: boolean; frameId?: string }> => {
	const entry = resolveRefEntry(session, ref);
	const frameId = entry.frameId;
	let nodeId = entry.backendDOMNodeId;

	let point = await tryGetBoxModel(relay, session, nodeId, frameId);
	if (!point) {
		const fallback = await fallbackResolve(relay, session, entry.role, entry.name, frameId);
		if (fallback === 'ambiguous') {
			throw new Error(
				`Element for ref "${ref}" is stale and multiple candidates match "${entry.role}" "${entry.name}". Run snapshot to get fresh refs.`,
			);
		}
		if (!fallback) {
			throw new Error(`Element for ref "${ref}" is no longer in the DOM. Run snapshot to refresh.`);
		}
		point = fallback;
		nodeId = fallback.backendDOMNodeId;
	}

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

		// verify the click actually changed the state
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const after = (await sendCdpCommand(
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

		// if coordinate-based click missed (e.g. hidden checkbox with custom styling), retry via JS
		if (after.result.value !== desired) {
			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: 'function() { this.click(); }',
					objectId,
				},
				{ frameId },
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
			description:
				'Click a snapshot ref. Auto-scrolls into view if needed. Use button="right" for context menus.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
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
			description:
				'Type text into the focused element. Use click, focus, or fill to focus first. Handles \\n as Enter and \\t as Tab.',
			inputSchema: {
				text: z.string().describe('Text to type (\\n for Enter, \\t for Tab)'),
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
			description: 'Clear an input field and type new text. Prefer over type when replacing the full value.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
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
					if ('select' in this && typeof this.select === 'function') {
						this.select();
					}
					if ('value' in this) {
						this.value = '';
						this.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
					}
				}`,
					objectId,
				},
				{ frameId },
			);
			session.setLastInteractedFrameId(frameId);
			await sendCdpCommand(relay, session, 'Input.insertText', { text: value }, { frameId });

			// Input.insertText already fires input events natively;
			// dispatch change because browsers only fire it on blur, not programmatic insertion
			await sendCdpCommand(
				relay,
				session,
				'Runtime.callFunctionOn',
				{
					functionDeclaration: `function() {
					this.dispatchEvent(new Event('change', { bubbles: true }));
				}`,
					objectId,
				},
				{ frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Filled ${ref} with "${value}".` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);

	server.registerTool(
		'hover',
		{
			description: 'Hover over an element by its ref. Auto-scrolls into view if needed.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
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
			description:
				'Press a key or combo (e.g. Enter, Tab, Escape, ArrowDown, Control+A, Shift+Enter). Supports all US keyboard keys.',
			inputSchema: {
				key: z.string().describe('Key or combo (e.g. Enter, Tab, Control+A, Shift+Enter, a, 1, /)'),
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
			description: 'Check a checkbox or toggle a switch on. No-op if already checked.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => setCheckedState(ref, true, relay, session, include_snapshot),
	);

	server.registerTool(
		'uncheck',
		{
			description: 'Uncheck a checkbox or toggle a switch off. No-op if already unchecked.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, include_snapshot }) => setCheckedState(ref, false, relay, session, include_snapshot),
	);

	server.registerTool(
		'drag',
		{
			description: 'Drag one element onto another by their refs.',
			inputSchema: {
				from_ref: z.string().describe('Ref of the element to drag'),
				to_ref: z.string().describe('Ref of the drop target'),
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
			description:
				'Scroll an element into the center of the viewport. Most interaction tools auto-scroll; use this for explicit scroll control.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
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
			description: 'Focus an element without clicking it. Useful for triggering focus-dependent UI.',
			inputSchema: {
				ref: z.string().describe('Ref from snapshot (e.g. e1)'),
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
			description: 'Upload a file to a file input element by ref.',
			inputSchema: {
				ref: z.string().describe('Ref of the file input element'),
				path: z.string().describe('Absolute path to the file on the local machine'),
				include_snapshot: includeSnapshotSchema,
			},
		},
		async ({ ref, path, include_snapshot }) => {
			if (!session.isConnected) return notConnectedError();
			const entry = resolveRefEntry(session, ref);
			await sendCdpCommand(
				relay,
				session,
				'DOM.setFileInputFiles',
				{
					files: [path],
					backendNodeId: entry.backendDOMNodeId,
				},
				{ frameId: entry.frameId },
			);

			const content: TextContent[] = [{ type: 'text', text: `Uploaded "${path}" to ${ref}.` }];
			await maybeSnapshot(include_snapshot, relay, session, content);

			return { content };
		},
	);
};
