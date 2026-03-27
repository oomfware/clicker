import { workspaceSchema } from '@oomfware/clicker-protocol';

import * as v from 'valibot';

export const POPUP_PORT_NAME = 'popup';

// #region popup → background messages

const setName = v.object({
	type: v.literal('popup:setName'),
	name: v.string(),
});

const createFromTab = v.object({
	type: v.literal('popup:createFromTab'),
	name: v.string(),
});

const popupMessageSchema = v.variant('type', [setName, createFromTab]);

export type PopupMessage = v.InferOutput<typeof popupMessageSchema>;

/** parses a raw message from the popup, returns undefined if invalid */
export const parsePopupMessage = (data: unknown): PopupMessage | undefined => {
	const result = v.safeParse(popupMessageSchema, data);
	return result.success ? result.output : undefined;
};

// #endregion

// #region background → popup state

const popupStateSchema = v.object({
	name: v.string(),
	connected: v.boolean(),
	error: v.optional(v.picklist(['name_conflict', 'version_mismatch'])),
	workspaces: v.array(workspaceSchema),
});

export type PopupState = v.InferOutput<typeof popupStateSchema>;

/** parses a state message from the background, returns undefined if invalid */
export const parsePopupState = (data: unknown): PopupState | undefined => {
	const result = v.safeParse(popupStateSchema, data);
	return result.success ? result.output : undefined;
};

// #endregion
