// ─── React Flow types ────────────────────────────────────────────────────────

import {
  sortKBEntities,
  buildIntentMap,
  buildAdjacency,
  markRootIntentsAsUsed,
  buildFlowNodes,
  buildFlowEdges,
  getActionRedirects,
  pickFirstIntentId,
  pickEdgeColor,
} from './parseKBActions';
import {
  decideSplitIntents,
  buildSplitNodes,
  resolveSplitEdges,
  countDegrees,
  SplitEdge,
  EdgeMeta,
  getSplitNodeId,
} from './parseKBSplit';
import {
  detectCycles,
  buildMirrorMap,
  buildMirrorNodes,
  buildFinalEdges,
} from './parseKBMirror';
import { NODE_WIDTH, NODE_HEIGHT, H_GAP, V_GAP } from './parseKBLayout';

export interface FlowNode {
  id: string;
  position: { x: number; y: number };
  data: {
    label: string;
    rawData?: any;
    isFirstIntent?: boolean;
    splitRole?: 'in' | 'out';
    splitPairId?: string;
    // Mirror node fields (set only on mirror nodes)
    isMirror?: boolean;
    mirrorOf?: string;      // exact split node ID this mirrors (e.g. "A__in__2" or "A")
    mirrorOfBase?: string;  // canonical intent ID (e.g. "A") — for checkAllIntentsAdded
  };
  type?: string;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  animated?: boolean;
  label?: string;
  style?: any;         // Add this line to allow custom line colors
  labelBgStyle?: any;  // Add this line to allow label background styling
  labelStyle?: any;    // Add this line to allow label text styling
}

// ─── Types matching the KB JSON shape ────────────────────────────────────────

export interface KBVersion {
  version: string;
  name: string;
  [key: string]: any;
}

export interface KBIntent {
  intentId: string;
  parentId: string | null;
  intentName: string;
  intentType?: string;
  sortOrder?: number;
  [key: string]: any;
}

export interface KBDtmfOption {
  dtmfPattern?: string;
  dtmfIntent?: string;
}

export interface KBActionPayload {
  dtmfType?: string;
  dtmfOptions?: KBDtmfOption[];
  dtmfIntentId?: string;
  nohIntent?: string;
  followUpIntent?: string;
  redirectIntent?: string;
  procId?: string;
  args?: string;
  [key: string]: any;
}

export interface KBAction {
  actionId: string;
  intentId: string;
  type: string;
  platform?: string;
  lang?: string;
  payload: KBActionPayload | string | null;
  sortOrder?: number;
  [key: string]: any;
}

export interface KBJson {
  version?: KBVersion;
  intents?: KBIntent[];
  actions?: KBAction[];
  [key: string]: any;
}

// Layout constants now live in ./parseKBLayout.

// ─── Main entry point ────────────────────────────────────────────────────────

export function parseKBToGraph(rawJson: any): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const kb = rawJson as KBJson;

  const hasIntents =
    kb.intents && Array.isArray(kb.intents) && kb.intents.length > 0 && 'intentId' in kb.intents[0];
  const hasActions = kb.actions && Array.isArray(kb.actions) && kb.actions.length > 0;

  if (hasIntents && hasActions) {
    parseKBFormatActions(kb, nodes, edges);
    return { nodes, edges };
  }

  if (hasIntents) {
    parseKBFormat(kb, nodes, edges);
    return { nodes, edges };
  }

  // ── Fallback: generic nested tree (legacy behaviour) ─────────────────────
  let currentY = 0;
  function traverse(item: any, depthX: number, parentId: string | null) {
    if (!item) return;
    const nodeId = item.id || `node-${Math.random().toString(36).substring(2, 9)}`;
    nodes.push({
      id: nodeId,
      position: { x: depthX * 250, y: currentY * 100 },
      data: { label: item.name || item.title || 'Unknown Node', rawData: item },
      type: 'default',
    });
    currentY += 1;
    if (parentId) {
      edges.push({
        id: `edge-${parentId}-${nodeId}`,
        source: parentId,
        target: nodeId,
        type: 'bezier',
        animated: true,
      });
    }
    if (item.children && Array.isArray(item.children)) {
      item.children.forEach((child: any) => traverse(child, depthX + 1, nodeId));
    }
  }
  traverse(rawJson, 0, null);
  return { nodes, edges };
}

// ─── Action-based graph parser ───────────────────────────────────────────────
//
// Implementation follows the user-defined steps:
//   1. Iterate over each action {...}
//   2. Read the source intentId
//   3. Read redirect intent ID(s) from payload:
//        - dtmfType=END_WITH_HASH  → payload.dtmfIntentId
//        - dtmfType=SINGLE_DIGIT   → payload.dtmfOptions[].dtmfIntent
//        - payload.nohIntent
//        - payload.followUpIntent
//        - payload.redirectIntent
//   4. Each (source → target) becomes a labelled edge in the graph
//   5. Intents are sorted by sortOrder / intentId before rendering

function parseKBFormatActions(kb: KBJson, nodes: FlowNode[], edges: FlowEdge[]): void {
  const { intents, actions } = sortKBEntities(kb);
  const intentMap = buildIntentMap(intents);

  const { adjacency, usedIntentIds } = buildAdjacency(actions, intentMap, (action) => {
    const payload = normalizePayload(action.payload);
    if (!payload) return [];
    return getActionRedirects(payload, intentMap);
  });

  markRootIntentsAsUsed(intents, adjacency, usedIntentIds);

  const sortedUsedIntents = intents.filter((intent) => usedIntentIds.has(intent.intentId));
  const firstIntentId = pickFirstIntentId(sortedUsedIntents);

  const { inboundCount, outboundCount } = countDegrees(adjacency);
  const splitIntentIds = decideSplitIntents(sortedUsedIntents, inboundCount, outboundCount);

  const builtSplitNodes = buildSplitNodes(
    sortedUsedIntents,
    splitIntentIds,
    inboundCount,
    outboundCount,
    firstIntentId,
  );
  for (const n of builtSplitNodes) nodes.push(n);

  // ── Step 5: resolve canonical edges into split-node edges ──────────────────
  const splitResolvedEdges: SplitEdge[] = resolveSplitEdges(adjacency, splitIntentIds);

  // ── Step 6: DFS cycle detection on the split-resolved edge graph ────────────
  // Ancestor tracking uses canonical base IDs so that A__in__1 and A__out__2
  // are both considered "A" in the path, which triggers a cycle when any form
  // of A appears as a descendant's outbound target.
  const cycleReturnKeys = detectCycles(
    splitResolvedEdges,
    sortedUsedIntents,
    splitIntentIds,
    compareIntentId,
  );

  // ── Step 7: build mirror map keyed by exact split targetId ─────────────────
  // Mirror ID = `${exactTargetId}__mirror` — one per unique return target.
  const mirrorIdByTargetId = buildMirrorMap(cycleReturnKeys);

  // ── Step 8: push mirror nodes ───────────────────────────────────────────────
  for (const n of buildMirrorNodes(mirrorIdByTargetId, intentMap, compareIntentId)) {
    nodes.push(n);
  }

  // ── Step 9: emit final FlowEdges ────────────────────────────────────────────
  for (const e of buildFinalEdges(splitResolvedEdges, cycleReturnKeys, mirrorIdByTargetId, pickEdgeColor)) {
    edges.push(e);
  }
}

function normalizePayload(payload: KBAction['payload']): KBActionPayload | null {
  if (!payload) return null;
  if (typeof payload === 'string') {
    try {
      return JSON.parse(payload);
    } catch {
      return null;
    }
  }
  return payload;
}

export interface IntentCheckResult {
  allAdded: boolean;
  totalIntents: number;
  addedIntents: number;
  missingIntents: string[];
}

/**
 * Checks whether all intents from the KB JSON are present as nodes in the graph.
 * An intent is considered "added" if it appears as a node (i.e., it has at least
 * one incoming or outgoing edge in the action-based graph).
 */
function compareIntentId(a?: string, b?: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

export function checkAllIntentsAdded(
  rawJson: any,
  nodes: FlowNode[],
): IntentCheckResult {
  const kb = rawJson as KBJson;
  const intents: KBIntent[] = kb.intents ?? [];

  const nodeIds = new Set(
    nodes.map((n) => {
      // Mirror nodes: mirrorOfBase is already the canonical intent ID
      if (n.data?.mirrorOfBase) return n.data.mirrorOfBase;
      // Split nodes: splitPairId is the canonical intent ID
      if (n.data?.splitPairId) return n.data.splitPairId;
      // Fallback regex strip for split IDs (e.g. "A__in__2" → "A")
      const splitMatch = n.id.match(/^(.*)__(in|out)__\d+$/);
      if (splitMatch) return splitMatch[1];
      return n.id;
    }),
  );

  const missingIntents = intents
    .filter((i) => !nodeIds.has(i.intentId))
    .map((i) => i.intentId);

  return {
    allAdded: missingIntents.length === 0,
    totalIntents: intents.length,
    addedIntents: intents.length - missingIntents.length,
    missingIntents,
  };
}

// The layoutActionGraph implementation now lives in ./parseKBLayout.ts.

// ─── parentId-only KB-format parser (used when no actions are present) ──────

function parseKBFormat(kb: KBJson, nodes: FlowNode[], edges: FlowEdge[]): void {
  const intents: KBIntent[] = kb.intents ?? [];
  const intentIdSet = new Set(intents.map(i => i.intentId));

  const childrenMap = new Map<string, KBIntent[]>();
  const rootIntents: KBIntent[] = [];

  for (const intent of intents) {
    const pid = intent.parentId ?? null;
    if (pid === null || pid === 'ROOT' || !intentIdSet.has(pid)) {
      rootIntents.push(intent);
    } else {
      if (!childrenMap.has(pid)) childrenMap.set(pid, []);
      childrenMap.get(pid)!.push(intent);
    }
  }

  childrenMap.forEach(children => children.sort(compareIntent));
  rootIntents.sort(compareIntent);

  const versionNodeId = kb.version ? `version-${kb.version.version}` : null;
  if (kb.version && versionNodeId) {
    nodes.push({
      id: versionNodeId,
      position: { x: 0, y: 0 },
      data: {
        label: `📦 ${kb.version.name ?? kb.version.version}`,
        rawData: kb.version,
      },
      type: 'input',
    });
  }

  function subtreeWidth(id: string): number {
    const children = childrenMap.get(id);
    if (!children || children.length === 0) return NODE_WIDTH;
    const total =
      children.reduce((sum, c) => sum + subtreeWidth(c.intentId) + H_GAP, 0) - H_GAP;
    return Math.max(NODE_WIDTH, total);
  }

  function placeNode(intent: KBIntent, cx: number, depth: number, parentNodeId: string | null) {
    const nodeId = intent.intentId;
    const y = depth * (NODE_HEIGHT + V_GAP);

    nodes.push({
      id: nodeId,
      position: { x: cx - NODE_WIDTH / 2, y },
      data: {
        label: `${intent.intentId}\n${intent.intentName}`,
        rawData: intent,
      },
      type: 'default',
    });

    const effectiveParent = parentNodeId ?? versionNodeId;
    if (effectiveParent) {
      edges.push({
        id: `edge-${effectiveParent}-${nodeId}`,
        source: effectiveParent,
        target: nodeId,
        type: 'smoothstep',
        animated: false,
      });
    }

    const children = childrenMap.get(nodeId);
    if (!children || children.length === 0) return;

    const totalWidth =
      children.reduce((sum, c) => sum + subtreeWidth(c.intentId) + H_GAP, 0) - H_GAP;
    let startX = cx - totalWidth / 2;
    for (const child of children) {
      const sw = subtreeWidth(child.intentId);
      placeNode(child, startX + sw / 2, depth + 1, nodeId);
      startX += sw + H_GAP;
    }
  }

  const totalRootWidth =
    rootIntents.reduce((sum, r) => sum + subtreeWidth(r.intentId) + H_GAP, 0) - H_GAP;
  const startDepth = versionNodeId ? 1 : 0;
  let startRootX = -totalRootWidth / 2;

  for (const root of rootIntents) {
    const sw = subtreeWidth(root.intentId);
    placeNode(root, startRootX + sw / 2, startDepth, null);
    startRootX += sw + H_GAP;
  }

  if (versionNodeId) {
    const vNode = nodes.find(n => n.id === versionNodeId);
    if (vNode) {
      vNode.position = { x: -NODE_WIDTH / 2, y: -(NODE_HEIGHT + V_GAP) };
    }
  }
}
