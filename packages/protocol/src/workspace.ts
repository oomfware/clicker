import * as v from 'valibot';

/** a tab within a workspace */
export const workspaceTabSchema = v.object({
	tabId: v.number(),
	url: v.string(),
	title: v.string(),
	active: v.boolean(),
});

export type WorkspaceTab = v.InferOutput<typeof workspaceTabSchema>;

/** a workspace (tab group) managed by the extension */
export const workspaceSchema = v.object({
	id: v.string(),
	title: v.string(),
	tabs: v.array(workspaceTabSchema),
});

export type Workspace = v.InferOutput<typeof workspaceSchema>;

/** a connected browser profile as seen by the relay */
export const browserSchema = v.object({
	connectionId: v.string(),
	name: v.string(),
	workspaceCount: v.number(),
});

export type Browser = v.InferOutput<typeof browserSchema>;

/** a browser profile with full workspace tree, used in status responses */
export const browserStatusSchema = v.object({
	connectionId: v.string(),
	name: v.string(),
	synced: v.boolean(),
	workspaces: v.array(workspaceSchema),
});

export type BrowserStatus = v.InferOutput<typeof browserStatusSchema>;
