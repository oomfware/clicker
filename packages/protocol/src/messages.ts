import * as v from 'valibot';

import { createMessageId } from './ids.ts';
import { browserStatusSchema, workspaceSchema, workspaceTabSchema } from './workspace.ts';

// #region result schema helper

/** creates a discriminated `{ ok: true, ... } | { ok: false, error: string }` union */
/*#__NO_SIDE_EFFECTS__*/
const resultSchema = <T extends v.ObjectEntries>(successFields: T) =>
	v.variant('ok', [
		v.object({ ok: v.literal(true), ...successFields }),
		v.object({ ok: v.literal(false), error: v.string() }),
	]);

// #endregion

// #region payload schemas

const extHello = v.object({
	type: v.literal('ext:hello'),
	name: v.string(),
	protocolVersion: v.pipe(v.number(), v.safeInteger()),
});

const relayWelcome = v.object({
	type: v.literal('relay:welcome'),
	connectionId: v.string(),
	protocolVersion: v.pipe(v.number(), v.safeInteger()),
});

/** relay→extension: connectionId already resolved by relay */
const workspaceCreate = v.object({
	type: v.literal('workspace:create'),
	title: v.string(),
});

/** session→relay: connectionId identifies which extension to route to */
const sessionWorkspaceCreate = v.object({
	type: v.literal('workspace:create'),
	connectionId: v.string(),
	title: v.string(),
});

const workspaceCreated = v.object({
	type: v.literal('workspace:created'),
	replyTo: v.optional(v.string()),
	result: resultSchema({ workspace: workspaceSchema }),
});

const workspaceDestroy = v.object({
	type: v.literal('workspace:destroy'),
	workspaceId: v.string(),
});

const workspaceDestroyed = v.object({
	type: v.literal('workspace:destroyed'),
	replyTo: v.optional(v.string()),
	workspaceId: v.string(),
	result: resultSchema({}),
});

const cdpCommand = v.object({
	type: v.literal('cdp:command'),
	workspaceId: v.string(),
	tabId: v.optional(v.number()),
	frameId: v.optional(v.string()),
	method: v.string(),
	params: v.optional(v.record(v.string(), v.unknown())),
});

const cdpResult = v.object({
	type: v.literal('cdp:result'),
	replyTo: v.string(),
	result: resultSchema({ value: v.unknown() }),
});

const cdpEvent = v.object({
	type: v.literal('cdp:event'),
	workspaceId: v.string(),
	tabId: v.number(),
	method: v.string(),
	params: v.optional(v.record(v.string(), v.unknown())),
	sessionId: v.optional(v.string()),
});

const tabAdopted = v.object({
	type: v.literal('tab:adopted'),
	workspaceId: v.string(),
	tabId: v.number(),
	url: v.string(),
	title: v.string(),
});

const tabRemoved = v.object({
	type: v.literal('tab:removed'),
	workspaceId: v.string(),
	tabId: v.number(),
});

const tabCreate = v.object({
	type: v.literal('tab:create'),
	workspaceId: v.string(),
	url: v.string(),
	active: v.boolean(),
});

const tabCreated = v.object({
	type: v.literal('tab:created'),
	replyTo: v.string(),
	workspaceId: v.string(),
	result: resultSchema({ tab: workspaceTabSchema }),
});

const tabClose = v.object({
	type: v.literal('tab:close'),
	workspaceId: v.string(),
	tabId: v.number(),
});

const tabClosed = v.object({
	type: v.literal('tab:closed'),
	replyTo: v.string(),
	workspaceId: v.string(),
	tabId: v.number(),
	result: resultSchema({}),
});

const tabActivate = v.object({
	type: v.literal('tab:activate'),
	workspaceId: v.string(),
	tabId: v.number(),
});

const tabActivated = v.object({
	type: v.literal('tab:activated'),
	replyTo: v.string(),
	workspaceId: v.string(),
	tabId: v.number(),
	result: resultSchema({}),
});

const workspaceSync = v.object({
	type: v.literal('workspace:sync'),
	workspaces: v.array(workspaceSchema),
});

const tabUpdated = v.object({
	type: v.literal('tab:updated'),
	workspaceId: v.string(),
	tabId: v.number(),
	url: v.optional(v.string()),
	title: v.optional(v.string()),
});

const tabActiveChanged = v.object({
	type: v.literal('tab:active-changed'),
	workspaceId: v.string(),
	tabId: v.number(),
});

const workspaceUpdated = v.object({
	type: v.literal('workspace:updated'),
	workspaceId: v.string(),
	title: v.optional(v.string()),
});

const ping = v.object({ type: v.literal('ping') });
const pong = v.object({ type: v.literal('pong') });

const sessionHello = v.object({
	type: v.literal('session:hello'),
	sessionId: v.string(),
	protocolVersion: v.pipe(v.number(), v.safeInteger()),
});

const sessionWelcome = v.object({
	type: v.literal('session:welcome'),
	sessionId: v.string(),
	protocolVersion: v.pipe(v.number(), v.safeInteger()),
});

const sessionWorkspaceList = v.object({
	type: v.literal('workspace:list'),
	connectionId: v.string(),
});

const sessionWorkspaceState = v.object({
	type: v.literal('workspace:state'),
	replyTo: v.string(),
	result: resultSchema({ workspaces: v.array(workspaceSchema) }),
});

const workspaceBind = v.object({
	type: v.literal('workspace:bind'),
	workspaceId: v.string(),
});

const workspaceBound = v.object({
	type: v.literal('workspace:bound'),
	replyTo: v.string(),
	result: resultSchema({
		connectionId: v.string(),
		workspace: workspaceSchema,
		otherSessions: v.pipe(v.number(), v.safeInteger()),
	}),
});

const statusQuery = v.object({
	type: v.literal('status:query'),
	connectionId: v.optional(v.string()),
});

const statusResult = v.object({
	type: v.literal('status:result'),
	replyTo: v.string(),
	browsers: v.array(browserStatusSchema),
});

// #endregion

// #region directional message schemas

const extensionToRelayPayload = v.variant('type', [
	extHello,
	workspaceSync,
	workspaceCreated,
	workspaceUpdated,
	workspaceDestroyed,
	cdpResult,
	cdpEvent,
	tabCreated,
	tabClosed,
	tabActivated,
	tabAdopted,
	tabUpdated,
	tabActiveChanged,
	tabRemoved,
	pong,
]);

const relayToExtensionPayload = v.variant('type', [
	relayWelcome,
	workspaceCreate,
	workspaceDestroy,
	cdpCommand,
	tabCreate,
	tabClose,
	tabActivate,
	ping,
]);

const sessionToRelayPayload = v.variant('type', [
	sessionHello,
	sessionWorkspaceList,
	workspaceBind,
	sessionWorkspaceCreate,
	workspaceDestroy,
	statusQuery,
	cdpCommand,
	tabCreate,
	tabClose,
	tabActivate,
	pong,
]);

const relayToSessionPayload = v.variant('type', [
	sessionWelcome,
	sessionWorkspaceState,
	statusResult,
	workspaceBound,
	workspaceCreated,
	workspaceDestroyed,
	cdpResult,
	tabCreated,
	tabClosed,
	tabActivated,
	cdpEvent,
	tabAdopted,
	tabRemoved,
	tabActiveChanged,
	ping,
]);

// #endregion

// #region message envelope

/*#__NO_SIDE_EFFECTS__*/
const envelope = <T extends v.GenericSchema>(payload: T) => {
	return v.object({
		id: v.string(),
		ts: v.pipe(v.number(), v.safeInteger()),
		payload,
	});
};

export const extensionToRelaySchema = envelope(extensionToRelayPayload);
export const relayToExtensionSchema = envelope(relayToExtensionPayload);
export const sessionToRelaySchema = envelope(sessionToRelayPayload);
export const relayToSessionSchema = envelope(relayToSessionPayload);

export type ExtensionToRelayMessage = v.InferOutput<typeof extensionToRelaySchema>;
export type RelayToExtensionMessage = v.InferOutput<typeof relayToExtensionSchema>;
export type SessionToRelayMessage = v.InferOutput<typeof sessionToRelaySchema>;
export type RelayToSessionMessage = v.InferOutput<typeof relayToSessionSchema>;

// #endregion

// #region helpers

/*#__NO_SIDE_EFFECTS__*/
const makeParser =
	<T extends v.GenericSchema>(schema: T) =>
	(data: { toString(): string }): v.InferOutput<T> | undefined => {
		try {
			const result = v.safeParse(schema, JSON.parse(String(data)));
			return result.success ? result.output : undefined;
		} catch {
			return undefined;
		}
	};

export const parseExtensionToRelayMessage = makeParser(extensionToRelaySchema);
export const parseRelayToExtensionMessage = makeParser(relayToExtensionSchema);
export const parseSessionToRelayMessage = makeParser(sessionToRelaySchema);
export const parseRelayToSessionMessage = makeParser(relayToSessionSchema);

/** creates a message envelope with a unique ID and timestamp */
/*#__NO_SIDE_EFFECTS__*/
export const createEnvelope = <T>(payload: T) => ({
	id: createMessageId(),
	ts: Date.now(),
	payload,
});

// #endregion
