import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { sendCdpCommand } from '../cdp.ts';
import type { RelayConnection } from '../connection.ts';
import type { RefEntry, SessionState } from '../session.ts';

import { notConnectedError, resolveRefToRemoteObject } from './shared.ts';

// #region accessibility tree types

/** raw CDP AXNode — flat list with childIds references, not embedded children */
interface CdpAXNode {
	nodeId: string;
	role: { value: string };
	name?: { value: string };
	childIds?: string[];
	properties?: { name: string; value: { value: unknown } }[];
	backendDOMNodeId?: number;
}

/** tree node with resolved children for recursive traversal */
interface AXNode extends CdpAXNode {
	children: AXNode[];
}

interface SnapshotOptions {
	interactiveOnly: boolean;
	compact: boolean;
	maxDepth?: number;
}

const INTERACTIVE_ROLES = new Set([
	'button',
	'link',
	'textbox',
	'checkbox',
	'radio',
	'combobox',
	'listbox',
	'menuitem',
	'menuitemcheckbox',
	'menuitemradio',
	'option',
	'searchbox',
	'slider',
	'spinbutton',
	'switch',
	'tab',
	'treeitem',
]);

const CONTENT_ROLES = new Set([
	'heading',
	'cell',
	'gridcell',
	'columnheader',
	'rowheader',
	'listitem',
	'article',
	'region',
	'main',
	'navigation',
]);

const COMPACT_SKIP_ROLES = new Set([
	'StaticText',
	'paragraph',
	'text',
	'emphasis',
	'strong',
	'mark',
	'code',
	'term',
	'description',
]);

const STRUCTURAL_ROLES = new Set([
	'group',
	'list',
	'table',
	'row',
	'rowgroup',
	'grid',
	'treegrid',
	'menu',
	'menubar',
	'toolbar',
	'tablist',
	'tree',
	'directory',
	'document',
	'application',
	'presentation',
]);

/** metadata for elements detected as interactive via cursor/onclick/tabindex heuristics */
interface CursorInteractiveInfo {
	kind: 'clickable' | 'editable' | 'focusable';
	hints: string[];
	text: string;
}

/** metadata for elements detected as scrollable containers via overflow heuristics */
interface ScrollContainerInfo {
	axes: ('x' | 'y')[];
}

/** composite key for per-node maps — unique across frames */
const nodeKey = (frameId: string | undefined, backendNodeId: number): string =>
	`${frameId ?? ''}:${backendNodeId}`;

// oxlint-disable-next-line no-misleading-character-class -- these are intentionally individual code points to strip
const INVISIBLE_CHARS = /[\uFEFF\u200B\u200C\u200D\u2060\u00A0]/g;

/** strips invisible/zero-width characters from display names */
const sanitizeName = (name: string): string => name.replace(INVISIBLE_CHARS, '');

// #endregion

/** reconstructs a tree from the flat CDP AXNode array using childIds */
const buildTree = (flatNodes: CdpAXNode[]): AXNode[] => {
	const idToNode = new Map<string, AXNode>();
	for (const node of flatNodes) {
		idToNode.set(node.nodeId, { ...node, children: [] });
	}

	const roots: AXNode[] = [];
	const hasParent = new Set<string>();

	for (const node of flatNodes) {
		const treeNode = idToNode.get(node.nodeId)!;
		if (node.childIds) {
			for (const childId of node.childIds) {
				const child = idToNode.get(childId);
				// InlineTextBox nodes are sub-glyph detail from Chrome's text rendering — always skip
				if (child && child.role.value !== 'InlineTextBox') {
					treeNode.children.push(child);
					hasParent.add(childId);
				}
			}
		}
	}

	for (const node of flatNodes) {
		if (!hasParent.has(node.nodeId)) {
			roots.push(idToNode.get(node.nodeId)!);
		}
	}

	// aggregate consecutive StaticText siblings and deduplicate redundant ones
	for (const node of idToNode.values()) {
		if (node.children.length === 0) continue;
		const merged: AXNode[] = [];
		let i = 0;
		while (i < node.children.length) {
			const child = node.children[i];
			if (child.role.value !== 'StaticText') {
				merged.push(child);
				i++;
				continue;
			}
			// collect run of consecutive StaticText siblings
			let text = child.name?.value ?? '';
			let j = i + 1;
			while (j < node.children.length && node.children[j].role.value === 'StaticText') {
				text += node.children[j].name?.value ?? '';
				j++;
			}
			if (j > i + 1 && child.name) {
				child.name = { value: text };
			}
			merged.push(child);
			i = j;
		}
		node.children = merged;

		// deduplicate lone StaticText child whose name matches parent
		if (
			node.children.length === 1 &&
			node.children[0].role.value === 'StaticText' &&
			node.children[0].name?.value === node.name?.value
		) {
			node.children = [];
		}
	}

	return roots;
};

/** indexes node.properties into a Map for O(1) lookups */
const indexProperties = (node: AXNode): Map<string, unknown> => {
	const map = new Map<string, unknown>();
	if (node.properties) {
		for (const p of node.properties) {
			map.set(p.name, p.value.value);
		}
	}
	return map;
};

/** gets a named property from a pre-indexed properties map */
const getProperty = (
	props: Map<string, unknown>,
	name: string,
): string | number | boolean | null | undefined => {
	const prop = props.get(name);
	if (
		prop === undefined ||
		prop === null ||
		typeof prop === 'string' ||
		typeof prop === 'number' ||
		typeof prop === 'boolean'
	) {
		return prop;
	}
	// oxlint-disable-next-line no-base-to-string -- fallback for unexpected AX property types
	return String(prop);
};

/** resolved iframe data for inlining into the snapshot tree */
interface ResolvedIframe {
	frameId: string;
	childRoots: AXNode[];
}

/** shared traversal state passed through buildSnapshotTree recursion */
interface SnapshotContext {
	refMap: RefEntry[];
	options: SnapshotOptions;
	iframeData?: Map<number, ResolvedIframe>;
	cursorMap?: Map<string, CursorInteractiveInfo>;
	scrollMap?: Map<string, ScrollContainerInfo>;
	frameId?: string;
}

/** builds an indented text tree matching agent-browser's format */
const buildSnapshotTree = (nodes: AXNode[], ctx: SnapshotContext, depth = 0): string => {
	const lines: string[] = [];

	for (const node of nodes) {
		const role = node.role.value;

		// check cursor-interactive and scroll-container status early — needed before skip decisions
		const cursorInfo =
			node.backendDOMNodeId != null
				? ctx.cursorMap?.get(nodeKey(ctx.frameId, node.backendDOMNodeId))
				: undefined;
		const scrollInfo =
			node.backendDOMNodeId != null
				? ctx.scrollMap?.get(nodeKey(ctx.frameId, node.backendDOMNodeId))
				: undefined;

		// iframe boundary — render synthetic node and inline child tree if available
		if (role === 'Iframe') {
			const name = sanitizeName(node.name?.value ?? '');
			const indent = '  '.repeat(depth);
			const ref = `e${ctx.refMap.length + 1}`;
			ctx.refMap.push({
				ref,
				role: 'Iframe',
				name,
				backendDOMNodeId: node.backendDOMNodeId,
				frameId: ctx.frameId,
			});
			const iframe = node.backendDOMNodeId != null ? ctx.iframeData?.get(node.backendDOMNodeId) : undefined;
			lines.push(`${indent}- iframe${name ? ` ${JSON.stringify(name)}` : ''} [ref=${ref}]`);
			if (iframe && iframe.childRoots.length > 0) {
				const childCtx: SnapshotContext = { ...ctx, iframeData: undefined, frameId: iframe.frameId };
				const childTree = buildSnapshotTree(iframe.childRoots, childCtx, depth + 1);
				if (childTree) lines.push(childTree);
			}
			continue;
		}

		// skip structurally meaningless nodes — but not if cursor-interactive or scrollable
		if (
			(role === 'none' || role === 'generic' || role === 'RootWebArea' || role === 'WebArea') &&
			!cursorInfo &&
			!scrollInfo
		) {
			if (node.children.length > 0) {
				lines.push(buildSnapshotTree(node.children, ctx, depth));
			}
			continue;
		}

		// collapse single-child structural wrappers that add indentation without semantic value
		if (
			STRUCTURAL_ROLES.has(role) &&
			!INTERACTIVE_ROLES.has(role) &&
			!cursorInfo &&
			!scrollInfo &&
			!node.name?.value &&
			node.children.length <= 1
		) {
			if (node.children.length > 0) {
				lines.push(buildSnapshotTree(node.children, ctx, depth));
			}
			continue;
		}

		if (ctx.options.maxDepth !== undefined && depth > ctx.options.maxDepth) {
			continue;
		}

		// use cursor-interactive text as fallback when ARIA name is empty
		const name = sanitizeName(node.name?.value ?? (cursorInfo ? cursorInfo.text : ''));
		const indent = '  '.repeat(depth);
		const isInteractive = INTERACTIVE_ROLES.has(role);
		const isContent = CONTENT_ROLES.has(role);
		const isCompactSkippedRole = ctx.options.compact && COMPACT_SKIP_ROLES.has(role);

		// build attribute list
		const attrs: string[] = [];

		const props = indexProperties(node);

		const level = getProperty(props, 'level');
		if (level !== undefined) attrs.push(`level=${String(level)}`);

		const disabled = getProperty(props, 'disabled');
		if (disabled === true) attrs.push('disabled');

		const required = getProperty(props, 'required');
		if (required === true) attrs.push('required');

		const expanded = getProperty(props, 'expanded');
		if (expanded !== undefined) attrs.push(`expanded=${String(expanded)}`);

		const selected = getProperty(props, 'selected');
		if (selected === true) attrs.push('selected');

		const checked = getProperty(props, 'checked');
		if (checked !== undefined) attrs.push(`checked=${String(checked)}`);

		// assign ref to interactive, named content, cursor-interactive, and scrollable elements (after properties)
		const shouldRef =
			isInteractive || (!ctx.options.interactiveOnly && isContent && name) || !!cursorInfo || !!scrollInfo;
		if (shouldRef) {
			const ref = `e${ctx.refMap.length + 1}`;
			ctx.refMap.push({ ref, role, name, backendDOMNodeId: node.backendDOMNodeId, frameId: ctx.frameId });
			attrs.push(`ref=${ref}`);
		}

		// format: - role "name" [attrs] kind [hints] scrollable [axes]: value
		const quotedName = name ? ` ${JSON.stringify(name)}` : '';
		const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
		const cursorSuffix = cursorInfo ? ` ${cursorInfo.kind} [${cursorInfo.hints.join(', ')}]` : '';
		const scrollSuffix = scrollInfo ? ` scrollable [${scrollInfo.axes.join(', ')}]` : '';
		const value = getProperty(props, 'value');
		const valueStr =
			value !== undefined && value !== '' && String(value) !== name ? `: ${String(value)}` : '';
		const childTree = node.children.length > 0 ? buildSnapshotTree(node.children, ctx, depth + 1) : '';
		const hasRenderedChildren = childTree.length > 0;
		const shouldRenderSelf =
			(!ctx.options.interactiveOnly || shouldRef) &&
			(!isCompactSkippedRole || shouldRef || hasRenderedChildren || valueStr !== '');

		if (shouldRenderSelf) {
			lines.push(`${indent}- ${role}${quotedName}${attrStr}${cursorSuffix}${scrollSuffix}${valueStr}`);
		}
		if (hasRenderedChildren) lines.push(childTree);
	}

	return lines.filter(Boolean).join('\n');
};

/** collects all Iframe AX nodes with backendDOMNodeIds from the tree */
const collectIframeNodes = (nodes: AXNode[]): AXNode[] => {
	const iframes: AXNode[] = [];
	const walk = (list: AXNode[]) => {
		for (const node of list) {
			if (node.role.value === 'Iframe' && node.backendDOMNodeId != null) {
				iframes.push(node);
			}
			if (node.children.length > 0) {
				walk(node.children);
			}
		}
	};
	walk(nodes);
	return iframes;
};

/**
 * resolves the frameId of an iframe element via DOM.describeNode.
 * prefers `node.frameId` (present on frame-owner elements), falls back to
 * `contentDocument.frameId`.
 */
const resolveIframeFrameId = async (
	relay: RelayConnection,
	session: SessionState,
	backendNodeId: number,
): Promise<string | null> => {
	try {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const desc = (await sendCdpCommand(relay, session, 'DOM.describeNode', {
			backendNodeId,
			depth: 1,
		})) as { node: { frameId?: string; contentDocument?: { frameId?: string } } };
		return desc.node.frameId ?? desc.node.contentDocument?.frameId ?? null;
	} catch {
		return null;
	}
};

// #region element detection

/**
 * JS source evaluated in the page to find elements that are visually interactive
 * (cursor:pointer, onclick, tabindex, contenteditable) but lack semantic ARIA roles.
 * returns element references and metadata — does not mutate the DOM.
 */
// derived from INTERACTIVE_ROLES so the injected JS stays in sync with the TS constant
const INTERACTIVE_ROLES_JS = JSON.stringify(Object.fromEntries([...INTERACTIVE_ROLES].map((r) => [r, 1])));

const CURSOR_DETECTION_JS = `(function() {
	var interactiveRoles = ${INTERACTIVE_ROLES_JS};
	var interactiveTags = {
		A:1, BUTTON:1, INPUT:1, SELECT:1, TEXTAREA:1, DETAILS:1, SUMMARY:1
	};
	var results = [];
	if (!document.body) return results;

	function scan(root) {
		var all = root.querySelectorAll('*');
		for (var i = 0; i < all.length; i++) {
			var el = all[i];
			if (el.shadowRoot) scan(el.shadowRoot);
			if (el.closest && el.closest('[hidden], [aria-hidden="true"]')) continue;
			if (interactiveTags[el.tagName]) continue;
			var role = el.getAttribute('role');
			if (role && interactiveRoles[role.toLowerCase()]) continue;
			var cs = getComputedStyle(el);
			var hasCursor = cs.cursor === 'pointer';
			var hasClick = el.hasAttribute('onclick') || el.onclick !== null;
			var ti = el.getAttribute('tabindex');
			var hasTab = ti !== null && ti !== '-1';
			var ce = el.getAttribute('contenteditable');
			var isEdit = ce === '' || ce === 'true';
			if (!hasCursor && !hasClick && !hasTab && !isEdit) continue;
			if (hasCursor && !hasClick && !hasTab && !isEdit) {
				var p = el.parentElement;
				if (p && getComputedStyle(p).cursor === 'pointer') continue;
			}
			var rect = el.getBoundingClientRect();
			if (rect.width === 0 || rect.height === 0) continue;
			results.push({
				el: el,
				text: (el.textContent || '').trim().slice(0, 100),
				hasClick: hasClick,
				hasCursor: hasCursor,
				hasTab: hasTab,
				isEdit: isEdit
			});
		}
	}

	scan(document.body);
	return results;
})()`;

/**
 * evaluates a detector JS expression in the page, extracts serializable metadata,
 * resolves each detected element to its backendNodeId, and calls a mapper to build
 * the result map. shared by cursor-interactive and scroll-container detection.
 *
 * @param relay the relay connection
 * @param session the current session state
 * @param jsExpression detector JS that returns `{ el, ...meta }[]`
 * @param metaExtractor JS function body to extract serializable fields from the array
 * @param mapper converts extracted metadata + resolved backendNodeId into a map entry
 * @param frameId optional iframe frame ID to scope detection
 * @returns map keyed by `frameId:backendNodeId`
 */
const detectElements = async <TMeta, TResult>(
	relay: RelayConnection,
	session: SessionState,
	jsExpression: string,
	metaExtractor: string,
	mapper: (meta: TMeta, backendNodeId: number) => TResult | undefined,
	frameId?: string,
): Promise<Map<string, TResult>> => {
	const map = new Map<string, TResult>();
	const target = frameId ? { frameId } : undefined;

	let arrayObjectId: string | undefined;
	let elArrayObjectId: string | undefined;

	try {
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const evalResult = (await sendCdpCommand(
			relay,
			session,
			'Runtime.evaluate',
			{ expression: jsExpression, returnByValue: false },
			target,
		)) as { result: { objectId?: string; type: string } };

		if (!evalResult.result.objectId || evalResult.result.type !== 'object') {
			return map;
		}

		arrayObjectId = evalResult.result.objectId;

		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const metaResult = (await sendCdpCommand(
			relay,
			session,
			'Runtime.callFunctionOn',
			{
				objectId: arrayObjectId,
				functionDeclaration: metaExtractor,
				returnByValue: true,
			},
			target,
		)) as { result: { value?: TMeta[] } };

		const metas = metaResult.result.value ?? [];
		if (metas.length === 0) return map;

		// reduce CDP round-trips: bulk-extract element refs via getProperties
		// so we only need N describeNode calls instead of N callFunctionOn + N describeNode
		// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
		const elArrayResult = (await sendCdpCommand(
			relay,
			session,
			'Runtime.callFunctionOn',
			{
				objectId: arrayObjectId,
				functionDeclaration: 'function() { return this.map(function(e) { return e.el; }); }',
				returnByValue: false,
			},
			target,
		)) as { result: { objectId?: string } };

		elArrayObjectId = elArrayResult.result.objectId;
		if (elArrayObjectId) {
			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const propsResult = (await sendCdpCommand(
				relay,
				session,
				'Runtime.getProperties',
				{ objectId: elArrayObjectId, ownProperties: true },
				target,
			)) as { result: { name: string; value?: { objectId?: string } }[] };

			const resolvePromises = propsResult.result
				.filter(
					(p): p is typeof p & { value: { objectId: string } } =>
						/^\d+$/.test(p.name) && p.value?.objectId != null,
				)
				.map(async (prop) => {
					const index = Number(prop.name);
					const meta = metas[index];
					if (!meta) return;
					try {
						// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
						const desc = (await sendCdpCommand(
							relay,
							session,
							'DOM.describeNode',
							{ objectId: prop.value.objectId },
							target,
						)) as { node: { backendNodeId: number } };

						const result = mapper(meta, desc.node.backendNodeId);
						if (result !== undefined) {
							map.set(nodeKey(frameId, desc.node.backendNodeId), result);
						}
					} catch {
						// skip elements that fail to resolve
					} finally {
						await sendCdpCommand(
							relay,
							session,
							'Runtime.releaseObject',
							{ objectId: prop.value.objectId },
							target,
						).catch(() => {});
					}
				});

			await Promise.all(resolvePromises);
		}
	} catch {
		// element detection is best-effort — don't fail the snapshot
	} finally {
		const releases: Promise<unknown>[] = [];
		if (elArrayObjectId) {
			releases.push(
				sendCdpCommand(relay, session, 'Runtime.releaseObject', { objectId: elArrayObjectId }, target).catch(
					() => {},
				),
			);
		}
		if (arrayObjectId) {
			releases.push(
				sendCdpCommand(relay, session, 'Runtime.releaseObject', { objectId: arrayObjectId }, target).catch(
					() => {},
				),
			);
		}
		if (releases.length > 0) await Promise.all(releases);
	}

	return map;
};

// #endregion

// #region cursor-interactive detection

type CursorMeta = { text: string; hasClick: boolean; hasCursor: boolean; hasTab: boolean; isEdit: boolean };

const CURSOR_META_EXTRACTOR = `function() {
	return this.map(function(e) {
		return { text: e.text, hasClick: e.hasClick, hasCursor: e.hasCursor, hasTab: e.hasTab, isEdit: e.isEdit };
	});
}`;

const cursorMapper = (meta: CursorMeta, _backendNodeId: number): CursorInteractiveInfo => {
	const kind = meta.hasClick || meta.hasCursor ? 'clickable' : meta.isEdit ? 'editable' : 'focusable';
	const hints: string[] = [];
	if (meta.hasCursor) hints.push('cursor:pointer');
	if (meta.hasClick) hints.push('onclick');
	if (meta.hasTab) hints.push('tabindex');
	if (meta.isEdit) hints.push('contenteditable');
	return { kind, hints, text: meta.text };
};

/** finds cursor-interactive elements and resolves their backendNodeIds */
const findCursorInteractiveElements = (
	relay: RelayConnection,
	session: SessionState,
	frameId?: string,
): Promise<Map<string, CursorInteractiveInfo>> =>
	detectElements(relay, session, CURSOR_DETECTION_JS, CURSOR_META_EXTRACTOR, cursorMapper, frameId);

// #endregion

// #region scroll-container detection

/**
 * JS source evaluated in the page to find scrollable overflow containers.
 * recurses into open shadow roots, deduplicates nested containers, and caps results.
 */
const SCROLL_DETECTION_JS = `(function() {
	var MIN_SIZE = 50;
	var MAX_RAW = 50;
	var MAX_RESULTS = 20;
	var scrollEl = document.scrollingElement;
	var raw = [];

	function scan(root) {
		var els = root.querySelectorAll('*');
		for (var i = 0; i < els.length && raw.length < MAX_RAW; i++) {
			var el = els[i];
			if (el === scrollEl) continue;
			if (el.shadowRoot) scan(el.shadowRoot);
			var cs = getComputedStyle(el);
			var ovX = cs.overflowX;
			var ovY = cs.overflowY;
			var sX = (ovX === 'auto' || ovX === 'scroll' || ovX === 'overlay') &&
				el.scrollWidth > el.clientWidth;
			var sY = (ovY === 'auto' || ovY === 'scroll' || ovY === 'overlay') &&
				el.scrollHeight > el.clientHeight;
			if (!sX && !sY) continue;
			var rect = el.getBoundingClientRect();
			if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) continue;
			raw.push({
				el: el, sX: sX, sY: sY,
				t: rect.top, l: rect.left, w: rect.width, h: rect.height
			});
		}
	}

	scan(document);

	var filtered = [];
	for (var j = 0; j < raw.length; j++) {
		var r = raw[j];
		var dominated = false;
		for (var k = 0; k < raw.length; k++) {
			if (k === j) continue;
			var o = raw[k];
			if (!r.el.contains(o.el) && !o.el.contains(r.el)) continue;
			if (r.sX !== o.sX || r.sY !== o.sY) continue;
			var dx = Math.abs(r.l - o.l);
			var dy = Math.abs(r.t - o.t);
			var dw = Math.abs(r.w - o.w);
			var dh = Math.abs(r.h - o.h);
			if (dx < 10 && dy < 10 && dw < 10 && dh < 10 && r.el.contains(o.el)) {
				dominated = true;
				break;
			}
		}
		if (!dominated) filtered.push(r);
	}

	var results = [];
	for (var m = 0; m < filtered.length && results.length < MAX_RESULTS; m++) {
		results.push({ el: filtered[m].el, sX: filtered[m].sX, sY: filtered[m].sY });
	}
	return results;
})()`;

type ScrollMeta = { sX: boolean; sY: boolean };

const SCROLL_META_EXTRACTOR = `function() {
	return this.map(function(e) {
		return { sX: e.sX, sY: e.sY };
	});
}`;

const scrollMapper = (meta: ScrollMeta, _backendNodeId: number): ScrollContainerInfo => {
	const axes: ('x' | 'y')[] = [];
	if (meta.sX) axes.push('x');
	if (meta.sY) axes.push('y');
	return { axes };
};

/** finds scrollable container elements and resolves their backendNodeIds */
const findScrollContainerElements = (
	relay: RelayConnection,
	session: SessionState,
	frameId?: string,
): Promise<Map<string, ScrollContainerInfo>> =>
	detectElements(relay, session, SCROLL_DETECTION_JS, SCROLL_META_EXTRACTOR, scrollMapper, frameId);

// #endregion

/** merges an array of settled map promises into a single map, skipping rejected results */
const mergeSettledMaps = <V>(results: PromiseSettledResult<Map<string, V>>[]): Map<string, V> => {
	const merged = new Map<string, V>();
	for (const settled of results) {
		if (settled.status === 'fulfilled') {
			for (const [key, info] of settled.value) {
				merged.set(key, info);
			}
		}
	}
	return merged;
};

/** takes a snapshot and updates the session's ref map, returns the tree text */
export const takeSnapshot = async (
	relay: RelayConnection,
	session: SessionState,
	options: SnapshotOptions = { interactiveOnly: false, compact: false },
): Promise<string> => {
	// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
	const result = (await sendCdpCommand(relay, session, 'Accessibility.getFullAXTree', {})) as {
		nodes: CdpAXNode[];
	};

	const roots = buildTree(result.nodes);

	// detect iframe nodes and resolve their child AX trees (one level deep)
	const iframeNodes = collectIframeNodes(roots);
	const iframeData = new Map<number, ResolvedIframe>();

	if (iframeNodes.length > 0) {
		await Promise.allSettled(
			iframeNodes.map(async (node) => {
				const backendNodeId = node.backendDOMNodeId!;
				const frameId = await resolveIframeFrameId(relay, session, backendNodeId);
				if (!frameId) return;

				try {
					// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
					const childResult = (await sendCdpCommand(
						relay,
						session,
						'Accessibility.getFullAXTree',
						{ frameId },
						{ frameId },
					)) as { nodes: CdpAXNode[] };

					iframeData.set(backendNodeId, { frameId, childRoots: buildTree(childResult.nodes) });
				} catch {
					// silently skip iframes whose AX tree fetch fails
				}
			}),
		);
	}

	// detect cursor-interactive and scrollable elements (main frame + first-level iframes in parallel)
	const cursorPromises = [
		findCursorInteractiveElements(relay, session),
		...iframeData.values().map((data) => findCursorInteractiveElements(relay, session, data.frameId)),
	];
	const scrollPromises = [
		findScrollContainerElements(relay, session),
		...iframeData.values().map((data) => findScrollContainerElements(relay, session, data.frameId)),
	];

	const [cursorResults, scrollResults] = await Promise.all([
		Promise.allSettled(cursorPromises),
		Promise.allSettled(scrollPromises),
	]);

	const cursorMap = mergeSettledMaps(cursorResults);
	const scrollMap = mergeSettledMaps(scrollResults);

	const refMap: RefEntry[] = [];
	const ctx: SnapshotContext = { refMap, options, iframeData, cursorMap, scrollMap };
	const tree = buildSnapshotTree(roots, ctx);
	session.setRefMap(refMap);
	if (tree) return tree;
	return options.interactiveOnly ? '(no interactive elements)' : '(empty page)';
};

export const registerStateTools = (
	server: McpServer,
	relay: RelayConnection,
	session: SessionState,
): void => {
	server.registerTool(
		'snapshot',
		{
			description:
				'Capture the accessibility tree of the active tab. Interactive elements are assigned refs (e.g. e1, e2) for use with interaction tools like click, fill, and hover. Prefer this over screenshot — it is faster, text-based, and provides the refs needed for interaction. Refs are invalidated by navigation, reload, or tab switch.',
			inputSchema: {
				interactive_only: z
					.boolean()
					.default(false)
					.describe('Show only interactive elements, while preserving enough structure to navigate them'),
				compact: z.boolean().default(false).describe('Reduce text-heavy noise in the snapshot output'),
				max_depth: z
					.number()
					.int()
					.positive()
					.optional()
					.describe('Limit rendering depth in the accessibility tree'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ interactive_only, compact, max_depth }) => {
			if (!session.isConnected) return notConnectedError();
			const tree = await takeSnapshot(relay, session, {
				interactiveOnly: interactive_only,
				compact,
				maxDepth: max_depth,
			});
			return { content: [{ type: 'text', text: tree }] };
		},
	);

	server.registerTool(
		'screenshot',
		{
			description:
				'Capture a visual screenshot. Only use when visual appearance matters (e.g. verifying layout, styling, or visual content like images and charts that are not in the accessibility tree). For reading page content, finding elements, or driving interaction, always use snapshot instead.',
			inputSchema: {
				full_page: z
					.boolean()
					.default(false)
					.describe('Capture the full scrollable page instead of just the viewport'),
				ref: z.string().optional().describe('Ref of an element to screenshot (overrides full_page)'),
				format: z.enum(['png', 'jpeg', 'webp']).default('png').describe('Image format'),
				quality: z.number().min(0).max(100).optional().describe('Compression quality for jpeg/webp (0-100)'),
			},
			annotations: { readOnlyHint: true },
		},
		async ({ full_page, ref, format, quality }) => {
			if (!session.isConnected) return notConnectedError();
			const screenshotParams: Record<string, unknown> = { format };
			if (quality !== undefined && format !== 'png') {
				screenshotParams.quality = quality;
			}

			const mimeType = `image/${format}`;

			if (ref) {
				const entry = session.resolveRef(ref);
				if (!entry?.backendDOMNodeId) {
					return { content: [{ type: 'text', text: `Unknown ref "${ref}".` }], isError: true };
				}
				if (entry.frameId) {
					return {
						content: [
							{
								type: 'text',
								text: `Element screenshots inside iframes are not yet supported. Use a viewport screenshot instead.`,
							},
						],
						isError: true,
					};
				}
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
				const box = (await sendCdpCommand(relay, session, 'DOM.getBoxModel', {
					backendNodeId: entry.backendDOMNodeId,
				})) as { model: { content: number[] } };
				const q = box.model.content;
				const minX = Math.min(q[0], q[2], q[4], q[6]);
				const minY = Math.min(q[1], q[3], q[5], q[7]);
				const maxX = Math.max(q[0], q[2], q[4], q[6]);
				const maxY = Math.max(q[1], q[3], q[5], q[7]);
				screenshotParams.clip = {
					x: minX,
					y: minY,
					width: maxX - minX,
					height: maxY - minY,
					scale: 1,
				};
			} else if (full_page) {
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
				const metrics = (await sendCdpCommand(relay, session, 'Page.getLayoutMetrics')) as {
					contentSize: { width: number; height: number };
				};
				screenshotParams.captureBeyondViewport = true;
				screenshotParams.clip = {
					x: 0,
					y: 0,
					width: metrics.contentSize.width,
					height: metrics.contentSize.height,
					scale: 1,
				};
			}

			// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
			const result = (await sendCdpCommand(relay, session, 'Page.captureScreenshot', screenshotParams)) as {
				data: string;
			};

			return {
				content: [{ type: 'image', data: result.data, mimeType }],
			};
		},
	);

	server.registerTool(
		'evaluate',
		{
			description: 'Run JavaScript and return the result.',
			inputSchema: {
				expression: z.string().describe('JavaScript expression to evaluate'),
				ref: z.string().optional().describe('Element ref from snapshot; the element is bound as `this`'),
			},
		},
		async ({ expression, ref }) => {
			if (!session.isConnected) return notConnectedError();

			type EvalResult = {
				result: { value?: unknown; description?: string; type: string; subtype?: string };
				exceptionDetails?: { text: string };
			};

			let result: EvalResult;
			if (ref) {
				const { objectId, frameId } = await resolveRefToRemoteObject(relay, session, ref);
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
				result = (await sendCdpCommand(
					relay,
					session,
					'Runtime.callFunctionOn',
					{
						objectId,
						functionDeclaration: `function() { return (${expression}); }`,
						returnByValue: true,
						awaitPromise: true,
					},
					{ frameId },
				)) as EvalResult;
			} else {
				// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
				result = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
					expression,
					returnByValue: true,
					awaitPromise: true,
				})) as EvalResult;
			}

			if (result.exceptionDetails) {
				return {
					content: [{ type: 'text', text: `Error: ${result.exceptionDetails.text}` }],
					isError: true,
				};
			}

			const value = result.result.value;
			const text = value === undefined ? (result.result.description ?? '(undefined)') : JSON.stringify(value);

			return { content: [{ type: 'text', text }] };
		},
	);

	server.registerTool(
		'emulate',
		{
			description:
				'Override viewport, DPR, mobile layout, user-agent, touch, and color scheme for device testing. Only provided fields are changed; omitted fields keep their previous values. Use reset=true to clear device overrides only (geo/timezone has its own reset via emulate_location).',
			inputSchema: {
				width: z.number().optional().describe('Viewport width in pixels'),
				height: z.number().optional().describe('Viewport height in pixels'),
				device_scale_factor: z.number().optional().describe('Device pixel ratio (default 1)'),
				mobile: z
					.boolean()
					.optional()
					.describe(
						'Enable mobile layout engine (viewport meta handling, overlay scrollbars). Independent from touch.',
					),
				user_agent: z.string().optional().describe('User-Agent string override'),
				color_scheme: z.enum(['light', 'dark']).optional().describe('Emulated color scheme preference'),
				touch: z
					.boolean()
					.optional()
					.describe('Enable touch input emulation. Independent from mobile layout.'),
				reset: z.boolean().default(false).describe('Clear device emulation overrides'),
			},
		},
		async ({ width, height, device_scale_factor, mobile, user_agent, color_scheme, touch, reset }) => {
			if (!session.isConnected) return notConnectedError();
			const actions: string[] = [];

			if (reset) {
				await Promise.all([
					sendCdpCommand(relay, session, 'Emulation.clearDeviceMetricsOverride'),
					sendCdpCommand(relay, session, 'Emulation.setTouchEmulationEnabled', { enabled: false }),
					sendCdpCommand(relay, session, 'Emulation.setEmitTouchEventsForMouse', { enabled: false }),
					sendCdpCommand(relay, session, 'Emulation.setEmulatedMedia', { features: [] }),
					sendCdpCommand(relay, session, 'Emulation.setUserAgentOverride', { userAgent: '' }),
				]);
				session.clearEmulationState();
				return { content: [{ type: 'text', text: 'Device emulation overrides cleared.' }] };
			}

			// device metrics are an all-or-nothing CDP call, so we merge with stored state
			if (
				width !== undefined ||
				height !== undefined ||
				device_scale_factor !== undefined ||
				mobile !== undefined
			) {
				// seed from current viewport if no prior metrics exist, so partial updates
				// (e.g. device_scale_factor alone) don't reset the viewport to 0x0
				const current = session.emulationState;
				if (current.width === undefined || current.height === undefined) {
					try {
						// oxlint-disable-next-line no-unsafe-type-assertion -- CDP response shape
						const vp = (await sendCdpCommand(relay, session, 'Runtime.evaluate', {
							expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })',
							returnByValue: true,
						})) as { result: { value?: string } };
						if (vp.result.value) {
							const parsed = JSON.parse(vp.result.value);
							session.mergeEmulationState({
								width: parsed.width,
								height: parsed.height,
							});
						}
					} catch {
						// fall through with 0x0 defaults
					}
				}

				const merged = session.mergeEmulationState({
					...(width !== undefined && { width }),
					...(height !== undefined && { height }),
					...(device_scale_factor !== undefined && { deviceScaleFactor: device_scale_factor }),
					...(mobile !== undefined && { mobile }),
				});

				await sendCdpCommand(relay, session, 'Emulation.setDeviceMetricsOverride', {
					width: merged.width ?? 0,
					height: merged.height ?? 0,
					deviceScaleFactor: merged.deviceScaleFactor ?? 1,
					mobile: merged.mobile ?? false,
				});

				const parts: string[] = [];
				if (width !== undefined || height !== undefined) {
					parts.push(`viewport ${merged.width ?? 'auto'}x${merged.height ?? 'auto'}`);
				}
				if (device_scale_factor !== undefined) parts.push(`DPR ${device_scale_factor}`);
				if (mobile !== undefined) parts.push(`mobile layout ${mobile ? 'on' : 'off'}`);
				actions.push(...parts);
			}

			if (user_agent !== undefined) {
				await sendCdpCommand(relay, session, 'Emulation.setUserAgentOverride', {
					userAgent: user_agent,
				});
				actions.push(`user-agent "${user_agent}"`);
			}

			if (color_scheme !== undefined) {
				await sendCdpCommand(relay, session, 'Emulation.setEmulatedMedia', {
					features: [{ name: 'prefers-color-scheme', value: color_scheme }],
				});
				actions.push(`color scheme ${color_scheme}`);
			}

			if (touch !== undefined) {
				await sendCdpCommand(relay, session, 'Emulation.setTouchEmulationEnabled', { enabled: touch });
				await sendCdpCommand(relay, session, 'Emulation.setEmitTouchEventsForMouse', {
					enabled: touch,
					...(touch && { configuration: 'mobile' }),
				});
				session.mergeEmulationState({ touch });
				actions.push(`touch ${touch ? 'enabled' : 'disabled'}`);
			}

			if (actions.length === 0) {
				return { content: [{ type: 'text', text: 'No emulation settings provided.' }] };
			}

			return { content: [{ type: 'text', text: `Emulation set: ${actions.join(', ')}.` }] };
		},
	);

	server.registerTool(
		'emulate_location',
		{
			description:
				'Override geolocation and timezone for location-dependent testing. Call with reset=true to clear.',
			inputSchema: {
				latitude: z.number().optional().describe('Latitude override'),
				longitude: z.number().optional().describe('Longitude override'),
				timezone: z
					.string()
					.optional()
					.describe('Timezone ID override (e.g. America/New_York, Europe/London)'),
				reset: z.boolean().default(false).describe('Clear geolocation and timezone overrides'),
			},
		},
		async ({ latitude, longitude, timezone, reset }) => {
			if (!session.isConnected) return notConnectedError();

			if (reset) {
				await Promise.all([
					sendCdpCommand(relay, session, 'Emulation.clearGeolocationOverride'),
					sendCdpCommand(relay, session, 'Emulation.setTimezoneOverride', { timezoneId: '' }),
				]);
				return { content: [{ type: 'text', text: 'Location overrides cleared.' }] };
			}

			const actions: string[] = [];

			if ((latitude !== undefined) !== (longitude !== undefined)) {
				return {
					content: [{ type: 'text', text: 'Both latitude and longitude must be provided together.' }],
					isError: true,
				};
			}

			if (latitude !== undefined && longitude !== undefined) {
				await sendCdpCommand(relay, session, 'Emulation.setGeolocationOverride', {
					latitude,
					longitude,
					accuracy: 1,
				});
				actions.push(`geolocation ${latitude},${longitude}`);
			}

			if (timezone !== undefined) {
				await sendCdpCommand(relay, session, 'Emulation.setTimezoneOverride', {
					timezoneId: timezone,
				});
				actions.push(`timezone ${timezone}`);
			}

			if (actions.length === 0) {
				return { content: [{ type: 'text', text: 'No location settings provided.' }] };
			}

			return { content: [{ type: 'text', text: `Location set: ${actions.join(', ')}.` }] };
		},
	);
};
