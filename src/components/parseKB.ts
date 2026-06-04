// ─── React Flow types ────────────────────────────────────────────────────────

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

interface KBVersion {
  version: string;
  name: string;
  [key: string]: any;
}

interface KBIntent {
  intentId: string;
  parentId: string | null;
  intentName: string;
  intentType?: string;
  sortOrder?: number;
  [key: string]: any;
}

interface KBDtmfOption {
  dtmfPattern?: string;
  dtmfIntent?: string;
}

interface KBActionPayload {
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

interface KBAction {
  actionId: string;
  intentId: string;
  type: string;
  platform?: string;
  lang?: string;
  payload: KBActionPayload | string | null;
  sortOrder?: number;
  [key: string]: any;
}

interface KBJson {
  version?: KBVersion;
  intents?: KBIntent[];
  actions?: KBAction[];
  [key: string]: any;
}

// ─── Layout constants ────────────────────────────────────────────────────────

const NODE_WIDTH  = 240;
const NODE_HEIGHT = 70;
const H_GAP       = 80;
const V_GAP       = 100;

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
  const intents: KBIntent[] = [...(kb.intents ?? [])].sort(compareIntent);
  const actions: KBAction[] = [...(kb.actions ?? [])].sort(compareAction);

  const intentMap = new Map<string, KBIntent>();
  for (const intent of intents) intentMap.set(intent.intentId, intent);

  const adjacency = new Map<
    string,
    Map<string, { labels: Set<string>; methods: Set<string>; order: number }>
  >();
  const usedIntentIds = new Set<string>();
  let edgeOrder = 0;

  for (const action of actions) {
    const sourceIntentId = action.intentId;
    if (!sourceIntentId || !intentMap.has(sourceIntentId)) continue;

    const payload = normalizePayload(action.payload);
    if (!payload) continue;

    const redirects = getActionRedirects(payload, intentMap);

    for (const redirect of redirects) {
      if (!redirect.targetId) continue;
      if (redirect.targetId === sourceIntentId) continue;
      if (!intentMap.has(redirect.targetId)) continue;

      let outgoing = adjacency.get(sourceIntentId);
      if (!outgoing) {
        outgoing = new Map();
        adjacency.set(sourceIntentId, outgoing);
      }

      let entry = outgoing.get(redirect.targetId);
      if (!entry) {
        entry = { labels: new Set(), methods: new Set(), order: edgeOrder++ };
        outgoing.set(redirect.targetId, entry);
      }

      entry.labels.add(redirect.label);
      entry.methods.add(redirect.method);

      usedIntentIds.add(sourceIntentId);
      usedIntentIds.add(redirect.targetId);
    }
  }

  for (const intent of intents) {
    if ((intent.parentId === 'ROOT' || intent.parentId == null) && adjacency.has(intent.intentId)) {
      usedIntentIds.add(intent.intentId);
    }
  }

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

function parseProcedureArgs(argsStr: string): Array<{ intentId: string; label: string }> {
  const results: Array<{ intentId: string; label: string }> = [];
  const regex = /(\w+IntentId):\s*["']([\w]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(argsStr)) !== null) {
    const key = match[1];
    const intentId = match[2];
    let label = key.replace(/([A-Z])/g, ' $1').trim(); // e.g. "successIntentId" -> "success Intent Id"
    label = label.replace(/ Intent Id$/, '').trim();     // -> "success"
    results.push({ intentId, label });
  }
  return results;
}

// Step 3: extract every redirect target ID from a single action payload
function getActionRedirects(
  payload: KBActionPayload,
  intentMap: Map<string, KBIntent>,
): Array<{ targetId: string; label: string; method: string }> {
  const redirects: Array<{ targetId: string; label: string; method: string }> = [];

  // 1) END_WITH_HASH -> dtmf
  if (payload.dtmfType === 'END_WITH_HASH' && payload.dtmfIntentId) {
    redirects.push({
      targetId: payload.dtmfIntentId,
      label: '[# entered]',
      method: 'dtmf'
    });
  }

  // 2) SINGLE_DIGIT -> dtmf
  if (Array.isArray(payload.dtmfOptions)) {
    for (const opt of payload.dtmfOptions) {
      if (!opt?.dtmfIntent) continue;
      redirects.push({
        targetId: opt.dtmfIntent,
        label: opt.dtmfPattern ? `[${opt.dtmfPattern}]` : '[digit]',
        method: 'dtmf'
      });
    }
  }

  // 3) nohIntent / followUpIntent / redirectIntent
  if (payload.nohIntent) {
    redirects.push({
      targetId: payload.nohIntent,
      label: 'noh',
      method: 'noh'
    });
  }

  if (payload.followUpIntent) {
    redirects.push({
      targetId: payload.followUpIntent,
      label: 'followUp',
      method: 'followUp'
    });
  }

  if (payload.redirectIntent) {
    redirects.push({
      targetId: payload.redirectIntent,
      label: 'redirect',
      method: 'redirect'
    });
  }

  // Parse procedure args string for intent IDs
  if (payload.args && typeof payload.args === 'string') {
    const parsedArgs = parseProcedureArgs(payload.args);
    for (const { intentId, label } of parsedArgs) {
      if (intentId && intentMap.has(intentId)) {
        redirects.push({ targetId: intentId, label, method: 'procArg' });
      }
    }
  }

  // Remove duplicates based on targetId AND label
  const seen = new Set<string>();
  return redirects.filter((r) => {
    const key = `${r.targetId}|${r.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Sorting helpers ─────────────────────────────────────────────────────────

function compareIntent(a: KBIntent, b: KBIntent): number {
  return (
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    compareIntentId(a.intentId, b.intentId)
  );
}

function compareAction(a: KBAction, b: KBAction): number {
  return (
    compareIntentId(a.intentId, b.intentId) ||
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    compareIntentId(a.actionId, b.actionId)
  );
}

function compareIntentId(a?: string, b?: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

// Picks the "first intent" — the entry point of the flow.
// Preference order:
//   1. The root intent (parentId === 'ROOT' / null) with the lowest
//      sortOrder, among intents in the graph.
//   2. The intent with the lowest sortOrder overall (e.g. the very
//      first intent in the KB).
//   3. The first intent in the supplied list.
// Returns null only when the list is empty.
function pickFirstIntentId(sortedIntents: KBIntent[]): string | null {
  if (sortedIntents.length === 0) return null;

  const roots = sortedIntents.filter(
    (i) => i.parentId === 'ROOT' || i.parentId == null,
  );
  const pool = roots.length > 0 ? roots : sortedIntents;
  return pool[0].intentId;
}

// "[1]" < "[2]" < "noh" < "followUp" < "redirect"
function compareEdgeLabel(a: string, b: string): number {
  const isDigitA = a.startsWith('[');
  const isDigitB = b.startsWith('[');
  if (isDigitA && !isDigitB) return -1;
  if (!isDigitA && isDigitB) return 1;
  return a.localeCompare(b);
}

// ─── Intent coverage check ────────────────────────────────────────────────────

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

// ─── Layout: BFS depth from root intents, then column packing ────────────────

function layoutActionGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  sortedIntents: KBIntent[],
  allIntents: KBIntent[],
): void {
  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const incomingCount = new Map<string, number>();
  const outgoing = new Map<string, string[]>();

  for (const node of nodes) {
    incomingCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }

  // Roots are intents that look like top-level entries (parentId === 'ROOT'),
  // falling back to nodes with no incoming edges, then to the first sorted node.
  const explicitRoots = allIntents
    .filter(i => (i.parentId === 'ROOT' || i.parentId == null) && nodeMap.has(i.intentId))
    .map(i => i.intentId);

  const inDegreeRoots = sortedIntents
    .filter(i => nodeMap.has(i.intentId) && (incomingCount.get(i.intentId) ?? 0) === 0)
    .map(i => i.intentId);

  const roots = explicitRoots.length > 0
    ? explicitRoots
    : inDegreeRoots.length > 0
      ? inDegreeRoots
      : sortedIntents.filter(i => nodeMap.has(i.intentId)).map(i => i.intentId).slice(0, 1);

  // BFS to assign depth. Use max-depth so that "deepest" path determines level.
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const r of roots) {
    depth.set(r, 0);
    queue.push(r);
  }

  while (queue.length > 0) {
    const id = queue.shift()!;
    const next = (depth.get(id) ?? 0) + 1;
    for (const tgt of outgoing.get(id) ?? []) {
      if ((depth.get(tgt) ?? -1) < next) {
        depth.set(tgt, next);
        queue.push(tgt);
      }
    }
  }

  // Any node not reachable from a root (cycles, orphans) → place in a tail row
  let maxDepth = 0;
  depth.forEach(d => { if (d > maxDepth) maxDepth = d; });
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, maxDepth + 1);
  }

  // Bucket nodes by depth, preserving the sortedIntents order within each level.
  const levels = new Map<number, FlowNode[]>();
  for (const intent of sortedIntents) {
    const node = nodeMap.get(intent.intentId);
    if (!node) continue;
    const lvl = depth.get(intent.intentId) ?? 0;
    const list = levels.get(lvl) ?? [];
    list.push(node);
    levels.set(lvl, list);
  }

  // Position: centre each row horizontally
  levels.forEach((levelNodes, level) => {
    const totalWidth = levelNodes.length * NODE_WIDTH + (levelNodes.length - 1) * H_GAP;
    const startX = -totalWidth / 2;
    levelNodes.forEach((node, index) => {
      node.position = {
        x: startX + index * (NODE_WIDTH + H_GAP),
        y: level * (NODE_HEIGHT + V_GAP),
      };
    });
  });
}

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
