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

  const inboundCount = new Map<string, number>();
  const outboundCount = new Map<string, number>();
  for (const [source, targets] of adjacency) {
    outboundCount.set(source, targets.size);
    for (const target of targets.keys()) {
      inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1);
    }
  }

  const splitIntentIds = new Set<string>();
  for (const intent of sortedUsedIntents) {
    const inbound = inboundCount.get(intent.intentId) ?? 0;
    const outbound = outboundCount.get(intent.intentId) ?? 0;
    const splitByInbound = inbound >= 4 && outbound > 0;
    const splitByOutbound = outbound >= 4 && inbound > 0;
    if (splitByInbound || splitByOutbound) splitIntentIds.add(intent.intentId);
  }

  const getSplitNodeId = (intentId: string, role: 'in' | 'out', index: number) => {
    return `${intentId}__${role}__${index}`;
  };

  for (const intent of sortedUsedIntents) {
    const isSplit = splitIntentIds.has(intent.intentId);
    const isFirst = intent.intentId === firstIntentId;
    const arrow = isFirst ? '▶ ' : '';

    if (!isSplit) {
      nodes.push({
        id: intent.intentId,
        position: { x: 0, y: 0 },
        data: {
          label: `${arrow}${intent.intentId}\n${intent.intentName}`,
          rawData: intent,
          isFirstIntent: isFirst,
        },
        type: 'default',
      });
      continue;
    }

    const inboundTotal = inboundCount.get(intent.intentId) ?? 0;
    const outboundTotal = outboundCount.get(intent.intentId) ?? 0;

    for (let index = 1; index <= inboundTotal; index += 1) {
      const prefix = isFirst && index === 1 ? arrow : '';
      nodes.push({
        id: getSplitNodeId(intent.intentId, 'in', index),
        position: { x: 0, y: 0 },
        data: {
          label: `${prefix}${intent.intentId}\n${intent.intentName} (in ${index})`,
          rawData: intent,
          isFirstIntent: isFirst && index === 1,
          splitRole: 'in',
          splitPairId: intent.intentId,
        },
        type: 'default',
      });
    }

    for (let index = 1; index <= outboundTotal; index += 1) {
      nodes.push({
        id: getSplitNodeId(intent.intentId, 'out', index),
        position: { x: 0, y: 0 },
        data: {
          label: `${intent.intentId}\n${intent.intentName} (out ${index})`,
          rawData: intent,
          splitRole: 'out',
          splitPairId: intent.intentId,
        },
        type: 'default',
      });
    }
  }

  // ── Step 5: resolve canonical edges into split-node edges ──────────────────
  type EdgeMeta = { labels: Set<string>; methods: Set<string>; order: number };
  type SplitEdge = {
    sourceId: string;   // final node ID after split assignment
    targetId: string;   // final node ID after split assignment
    sourceBase: string; // canonical intent ID (pre-split)
    targetBase: string; // canonical intent ID (pre-split)
    meta: EdgeMeta;
  };

  const outboundIndexBySource = new Map<string, number>();
  const inboundIndexByTarget  = new Map<string, number>();
  const splitResolvedEdges: SplitEdge[] = [];

  for (const [source, targets] of adjacency) {
    const sortedTargets = [...targets.entries()].sort((a, b) => a[1].order - b[1].order);
    for (const [target, meta] of sortedTargets) {
      let sourceId = source;
      if (splitIntentIds.has(source)) {
        const idx = (outboundIndexBySource.get(source) ?? 0) + 1;
        outboundIndexBySource.set(source, idx);
        sourceId = getSplitNodeId(source, 'out', idx);
      }
      let targetId = target;
      if (splitIntentIds.has(target)) {
        const idx = (inboundIndexByTarget.get(target) ?? 0) + 1;
        inboundIndexByTarget.set(target, idx);
        targetId = getSplitNodeId(target, 'in', idx);
      }
      splitResolvedEdges.push({ sourceId, targetId, sourceBase: source, targetBase: target, meta });
    }
  }

  // ── Step 6: DFS cycle detection on the split-resolved edge graph ────────────
  // Ancestor tracking uses canonical base IDs so that A__in__1 and A__out__2
  // are both considered "A" in the path, which triggers a cycle when any form
  // of A appears as a descendant's outbound target.

  const getBaseIntentId = (nodeId: string): string => {
    const m = nodeId.match(/^(.*)__(in|out)__\d+$/);
    return m ? m[1] : nodeId;
  };

  const splitAdj = new Map<string, SplitEdge[]>();
  const incomingCountSplit = new Map<string, number>();
  for (const e of splitResolvedEdges) {
    if (!splitAdj.has(e.sourceId)) splitAdj.set(e.sourceId, []);
    splitAdj.get(e.sourceId)!.push(e);
    incomingCountSplit.set(e.targetId, (incomingCountSplit.get(e.targetId) ?? 0) + 1);
  }

  const cycleReturnKeys = new Set<string>(); // "sourceId\0targetId"
  const visited = new Map<string, 'gray' | 'black'>();
  const ancestorBaseCounts = new Map<string, number>();

  const dfs = (nodeId: string): void => {
    visited.set(nodeId, 'gray');
    const base = getBaseIntentId(nodeId);
    ancestorBaseCounts.set(base, (ancestorBaseCounts.get(base) ?? 0) + 1);

    const outgoing = splitAdj.get(nodeId) ?? [];
    // process in edge-insertion order for determinism
    outgoing.sort((a, b) => a.meta.order - b.meta.order);
    for (const edge of outgoing) {
      if ((ancestorBaseCounts.get(edge.targetBase) ?? 0) > 0) {
        // targetBase is currently in the ancestor path → cycle return
        cycleReturnKeys.add(`${edge.sourceId}\0${edge.targetId}`);
        continue;
      }
      if (visited.get(edge.targetId) !== 'black') {
        dfs(edge.targetId);
      }
    }

    const remaining = (ancestorBaseCounts.get(base) ?? 1) - 1;
    if (remaining <= 0) ancestorBaseCounts.delete(base);
    else ancestorBaseCounts.set(base, remaining);
    visited.set(nodeId, 'black');
  };

  // Collect all split-graph node IDs
  const allSplitNodeIds = new Set<string>();
  for (const e of splitResolvedEdges) {
    allSplitNodeIds.add(e.sourceId);
    allSplitNodeIds.add(e.targetId);
  }

  // Start from explicit root intents first (prefer ROOT/null parentId), then sweep remaining
  const explicitRootIds = sortedUsedIntents
    .filter((i) => i.parentId === 'ROOT' || i.parentId == null)
    .map((i) => (splitIntentIds.has(i.intentId) ? getSplitNodeId(i.intentId, 'out', 1) : i.intentId))
    .filter((id) => allSplitNodeIds.has(id));

  const traversalOrder = [...allSplitNodeIds].sort(compareIntentId);
  const traversalStarts = [...new Set([...explicitRootIds, ...traversalOrder])];

  for (const startId of traversalStarts) {
    if (visited.get(startId) !== 'black') dfs(startId);
  }

  // ── Step 7: build mirror map keyed by exact split targetId ─────────────────
  // Mirror ID = `${exactTargetId}__mirror` — one per unique return target.
  const mirrorIdByTargetId = new Map<string, string>(); // exact targetId → mirrorNodeId
  for (const key of cycleReturnKeys) {
    const targetId = key.split('\0')[1];
    if (!mirrorIdByTargetId.has(targetId)) {
      mirrorIdByTargetId.set(targetId, `${targetId}__mirror`);
    }
  }

  // ── Step 8: push mirror nodes ───────────────────────────────────────────────
  for (const [targetId, mirrorNodeId] of [...mirrorIdByTargetId.entries()].sort((a, b) => compareIntentId(a[0], b[0]))) {
    const splitMatch = targetId.match(/^(.*)__(in|out)__(\d+)$/);
    const mirrorOfBase = splitMatch ? splitMatch[1] : targetId;
    const role = splitMatch ? (splitMatch[2] as 'in' | 'out') : null;
    const index = splitMatch ? Number(splitMatch[3]) : null;

    const intent = intentMap.get(mirrorOfBase);
    let label: string;
    if (role !== null && index !== null) {
      // e.g. "A' (in 2)\n<intentName>"
      label = intent
        ? `${mirrorOfBase}' (${role} ${index})\n${intent.intentName}`
        : `${mirrorOfBase}' (${role} ${index})`;
    } else {
      // non-split ancestor, e.g. "A'\n<intentName>"
      label = intent ? `${mirrorOfBase}'\n${intent.intentName}` : `${mirrorOfBase}'`;
    }

    nodes.push({
      id: mirrorNodeId,
      position: { x: 0, y: 0 },
      data: {
        label,
        rawData: intent,
        isMirror: true,
        mirrorOf: targetId,       // exact split node ID (e.g. "A__in__2" or "A")
        mirrorOfBase,             // canonical intent ID (e.g. "A") — for coverage checks
      },
      type: 'default',
    });
  }

  // ── Step 9: emit final FlowEdges ────────────────────────────────────────────
  for (const edge of splitResolvedEdges) {
    const isCycleReturn = cycleReturnKeys.has(`${edge.sourceId}\0${edge.targetId}`);
    const finalTarget = isCycleReturn
      ? (mirrorIdByTargetId.get(edge.targetId) ?? `${edge.targetId}__mirror`)
      : edge.targetId;

    let strokeColor = '#b1b1b7';
    if (edge.meta.methods.has('dtmf'))      strokeColor = '#10b981';
    else if (edge.meta.methods.has('noh'))       strokeColor = '#f43f5e';
    else if (edge.meta.methods.has('followUp'))  strokeColor = '#f59e0b';
    else if (edge.meta.methods.has('redirect'))  strokeColor = '#3b82f6';
    else if (edge.meta.methods.has('procArg'))   strokeColor = '#8b5cf6';

    edges.push({
      id: `${edge.sourceId}-${finalTarget}`,
      source: edge.sourceId,
      target: finalTarget,
      type: 'straight',
      animated: false,
      label: [...edge.meta.labels].join(', '),
      style: { stroke: strokeColor, strokeWidth: 2 },
      labelBgStyle: { fill: '#ffffff', color: '#fff', fillOpacity: 0.8 },
      labelStyle: { fill: strokeColor, fontWeight: 700 },
    });
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
