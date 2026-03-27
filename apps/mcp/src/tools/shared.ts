import type { WorkspaceTab } from '@oomfware/clicker-protocol';

import { z } from 'zod';

import { sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { RefEntry, SessionState } from '../session.ts';

import { takeSnapshot } from './state.ts';

export type TextContent = { type: 'text'; text: string };

/** standard error response for tools that require a workspace connection */
export const notConnectedError = (): { content: TextContent[]; isError: true } => ({
	content: [
		{
			type: 'text',
			text: 'Not connected to a workspace. The previously connected workspace may have been destroyed. Call status() to see available browsers and workspaces, then connect_workspace() or create_workspace().',
		},
	],
	isError: true,
});

/** formats a tab as a single display line, marking the active tab with `>` */
export const formatTabLine = (tab: WorkspaceTab, activeTabId?: number | null): string =>
	`${tab.tabId === activeTabId ? '> ' : '  '}[${tab.tabId}] ${tab.title} (${tab.url})`;

export const includeSnapshotSchema = z
	.boolean()
	.default(false)
	.describe('Return an updated snapshot after the action');

/** appends snapshot to content array if requested */
export const maybeSnapshot = async (
	includeSnapshot: boolean,
	relay: RelayConnection,
	session: SessionState,
	content: TextContent[],
): Promise<void> => {
	if (!includeSnapshot) return;
	content.push({ type: 'text', text: await takeSnapshot(relay, session) });
};

// #region element resolution

/** resolves a ref, throwing if unknown or missing DOM node */
export const resolveRefEntry = (
	session: SessionState,
	ref: string,
): RefEntry & { backendDOMNodeId: number } => {
	const entry = session.resolveRef(ref);
	if (!entry)
		throw new Error(
			`Unknown ref "${ref}". Refs are created by snapshot() and cleared on navigation, reload, or tab switch. Call snapshot() to get fresh refs.`,
		);
	if (!entry.backendDOMNodeId) throw new Error(`Ref "${ref}" has no associated DOM node.`);
	// oxlint-disable-next-line no-unsafe-type-assertion -- narrowed by guard above
	return entry as typeof entry & { backendDOMNodeId: number };
};

/** resolves a ref to its remote object ID and frame context */
export const resolveRefToRemoteObject = async (
	relay: RelayConnection,
	session: SessionState,
	ref: string,
): Promise<{ objectId: string; frameId?: string; backendDOMNodeId: number }> => {
	const entry = resolveRefEntry(session, ref);
	const objectId = await resolveNodeToObjectId(relay, session, entry.backendDOMNodeId, entry.frameId);
	return { objectId, frameId: entry.frameId, backendDOMNodeId: entry.backendDOMNodeId };
};

/** extracts center coordinates from a box model content quad */
export const centerOfQuad = (q: number[]): { x: number; y: number } => ({
	x: (q[0] + q[2] + q[4] + q[6]) / 4,
	y: (q[1] + q[3] + q[5] + q[7]) / 4,
});

/** tries to get box model center, returns null on failure (stale node) */
export const tryGetBoxModel = async (
	relay: RelayConnection,
	session: SessionState,
	backendNodeId: number,
	frameId?: string,
): Promise<{ x: number; y: number } | null> => {
	try {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const box = (await sendCdpCommand(
			relay,
			session,
			'DOM.getBoxModel',
			{
				backendNodeId,
			},
			{ frameId },
		)) as { model: { content: number[] } };
		return centerOfQuad(box.model.content);
	} catch {
		return null;
	}
};

// #endregion

// #region mouse/click

/** dispatches a mouseMoved + mousePressed + mouseReleased sequence */
export const dispatchClick = async (
	relay: RelayConnection,
	session: SessionState,
	x: number,
	y: number,
	clickCount = 1,
	button: 'left' | 'right' | 'middle' = 'left',
	frameId?: string,
): Promise<void> => {
	await sendCdpCommand(
		relay,
		session,
		'Input.dispatchMouseEvent',
		{
			type: 'mouseMoved',
			x,
			y,
		},
		{ frameId },
	);
	await sendCdpCommand(
		relay,
		session,
		'Input.dispatchMouseEvent',
		{
			type: 'mousePressed',
			x,
			y,
			button,
			buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
			clickCount,
		},
		{ frameId },
	);
	await sendCdpCommand(
		relay,
		session,
		'Input.dispatchMouseEvent',
		{
			type: 'mouseReleased',
			x,
			y,
			button,
			buttons: 0,
			clickCount,
		},
		{ frameId },
	);
};

// #endregion

/** CDP modifier bitmasks */
export const CDP_MODIFIER_CTRL = 2;
export const CDP_MODIFIER_META = 4;

/** resolves a DOM node to a remote object ID */
export const resolveNodeToObjectId = async (
	relay: RelayConnection,
	session: SessionState,
	backendNodeId: number,
	frameId?: string,
): Promise<string> => {
	// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
	const resolved = (await sendCdpCommand(
		relay,
		session,
		'DOM.resolveNode',
		{
			backendNodeId,
		},
		{ frameId },
	)) as { object: { objectId: string } };
	return resolved.object.objectId;
};

/**
 * briefly listens for navigation/load/dialog events after an action, returning early
 * if nothing happens within a short quiet window. prevents the next tool call from
 * running before the page has settled.
 */
export const waitForStabilization = (
	relay: RelayConnection,
	session: SessionState,
	timeoutMs = 1000,
): Promise<void> => {
	return new Promise((resolve) => {
		let quietTimer: ReturnType<typeof setTimeout>;
		let eventSeen = false;
		let settled = false;

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(quietTimer);
			clearTimeout(maxTimer);
			relay.removeListener('cdp:event', onEvent);
			resolve();
		};

		const resetQuiet = () => {
			clearTimeout(quietTimer);
			quietTimer = setTimeout(finish, 100);
		};

		const maxTimer = setTimeout(finish, timeoutMs);

		const onEvent = (
			workspaceId: string,
			tabId: number,
			method: string,
			_params?: Record<string, unknown>,
			eventSessionId?: string,
		) => {
			if (workspaceId !== session.workspaceId) return;
			if (session.activeTabId !== null && tabId !== session.activeTabId) return;
			// ignore events from child sessions (iframe navigations, loads)
			if (eventSessionId) return;
			if (
				method === 'Page.loadEventFired' ||
				method === 'Page.frameNavigated' ||
				method === 'Page.javascriptDialogOpening'
			) {
				eventSeen = true;
				resetQuiet();
			}
		};

		relay.on('cdp:event', onEvent);

		// if no interesting events fire within 50ms, finish immediately
		// (only extend to 100ms quiet window after an event is seen)
		quietTimer = setTimeout(() => {
			if (!eventSeen) {
				finish();
			}
		}, 50);
	});
};
