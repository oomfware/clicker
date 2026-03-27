import { TOOL_TIMEOUT_DEFAULT, TOOL_TIMEOUT_MAX, TOOL_TIMEOUT_MIN } from '@oomfware/clicker-protocol';

import type { RelayConnection } from './connection.ts';
import type { SessionState } from './session.ts';

/** clamps a user-provided timeout to the allowed range */
export const clampTimeout = (timeout?: number): number => {
	if (timeout === undefined) return TOOL_TIMEOUT_DEFAULT;
	return Math.max(TOOL_TIMEOUT_MIN, Math.min(TOOL_TIMEOUT_MAX, timeout));
};

export interface CdpCommandTarget {
	tabId?: number;
	frameId?: string;
}

/** sends a CDP command and returns the result; targets `tabId` if given, otherwise the active tab */
export const sendCdpCommand = async (
	relay: RelayConnection,
	session: SessionState,
	method: string,
	params?: Record<string, unknown>,
	target?: CdpCommandTarget,
): Promise<unknown> => {
	const tabId = target?.tabId;
	const frameId = target?.frameId;
	if (!session.workspaceId) {
		throw new Error(
			'Not connected to a workspace. The previously connected workspace may have been destroyed. Use create_workspace or connect_workspace first.',
		);
	}
	if (!tabId && !session.activeTabId) {
		throw new Error(
			'No tab is currently selected. Use select_tab, or open a new tab with navigate(target="foreground_tab").',
		);
	}

	const response = await relay.request({
		type: 'cdp:command',
		workspaceId: session.workspaceId,
		tabId: tabId ?? session.activeTabId ?? undefined,
		frameId,
		method,
		params: params ?? {},
	});

	if (response.payload.type !== 'cdp:result') {
		throw new Error('Unexpected response from relay');
	}

	if (!response.payload.result.ok) {
		throw new Error(response.payload.result.error);
	}

	return response.payload.result.value;
};
