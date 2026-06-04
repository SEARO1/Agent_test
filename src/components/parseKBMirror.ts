import { FlowNode, FlowEdge } from './parseKB';
import type { KBIntent } from './parseKB';
import { SplitEdge, getSplitNodeId } from './parseKBSplit';

// ─── Base ID extraction ──────────────────────────────────────────────────────

/**
 * Returns the canonical intent ID for any node ID, including split copies.
 * `A__in__2` and `A__out__3` both map to `A`. Non-split IDs pass through
 * unchanged. Used as the key in the DFS ancestor map so all forms of a
 * split intent collapse to the same ancestor.
 */
export function getBaseIntentId(nodeId: string): string {
  const m = nodeId.match(/^(.*)__(in|out)__\d+$/);
  return m ? m[1] : nodeId;
}

// ─── Step 6: split-edge adjacency ────────────────────────────────────────────

/**
 * Builds a `sourceId → SplitEdge[]` adjacency from the supplied
 * split-resolved edges. Deterministic order: outgoing edges at a node
 * are NOT re-sorted here \u2014 callers can sort by `meta.order` if they
 * need a specific traversal order.
 */
export function buildSplitAdjacency(
  splitEdges: SplitEdge[],
): Map<string, SplitEdge[]> {
  const adj = new Map<string, SplitEdge[]>();
  for (const e of splitEdges) {
    let list = adj.get(e.sourceId);
    if (!list) {
      list = [];
      adj.set(e.sourceId, list);
    }
    list.push(e);
  }
  return adj;
}

// ─── Step 6: DFS cycle detection ─────────────────────────────────────────────

/** Set of `"<sourceId>\\0<targetId>"` keys for edges that are cycle returns. */
export type CycleReturnKeys = Set<string>;

/**
 * Runs DFS over the split-resolved edge graph and reports every edge
 * whose target canonical base ID is currently in the ancestor path.
 *
 * Ancestor tracking is keyed by canonical base IDs (so `A__in__1` and
 * `A__out__2` both count as `A`), which means a back-edge to ANY form
 * of an in-path intent registers as a cycle return.
 *
 * Traversal starts from explicit root intents first (parentId ROOT /
 * null), then sweeps any remaining unvisited split-graph nodes for
 * determinism.
 */
export function detectCycles(
  splitEdges: SplitEdge[],
  sortedUsedIntents: KBIntent[],
  splitIntentIds: Set<string>,
  compareIntentId: (a?: string, b?: string) => number,
): CycleReturnKeys {
  const adj = buildSplitAdjacency(splitEdges);

  const cycleReturnKeys: CycleReturnKeys = new Set();
  const visited = new Map<string, 'gray' | 'black'>();
  const ancestorBaseCounts = new Map<string, number>();

  const dfs = (nodeId: string): void => {
    visited.set(nodeId, 'gray');
    const base = getBaseIntentId(nodeId);
    ancestorBaseCounts.set(base, (ancestorBaseCounts.get(base) ?? 0) + 1);

    const outgoing = adj.get(nodeId) ?? [];
    // Process in edge-insertion order for determinism.
    outgoing.sort((a, b) => a.meta.order - b.meta.order);
    for (const edge of outgoing) {
      if ((ancestorBaseCounts.get(edge.targetBase) ?? 0) > 0) {
        // targetBase is currently in the ancestor path \u2192 cycle return
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

  // Collect all split-graph node IDs.
  const allSplitNodeIds = new Set<string>();
  for (const e of splitEdges) {
    allSplitNodeIds.add(e.sourceId);
    allSplitNodeIds.add(e.targetId);
  }

  // Start from explicit root intents first (prefer ROOT/null parentId),
  // then sweep any remaining unvisited split-graph nodes.
  const explicitRootIds = sortedUsedIntents
    .filter((i) => i.parentId === 'ROOT' || i.parentId == null)
    .map((i) =>
      splitIntentIds.has(i.intentId) ? getSplitNodeId(i.intentId, 'out', 1) : i.intentId,
    )
    .filter((id) => allSplitNodeIds.has(id));

  const traversalOrder = [...allSplitNodeIds].sort(compareIntentId);
  const traversalStarts = [...new Set([...explicitRootIds, ...traversalOrder])];

  for (const startId of traversalStarts) {
    if (visited.get(startId) !== 'black') dfs(startId);
  }

  return cycleReturnKeys;
}

// ─── Step 7: build mirror map ────────────────────────────────────────────────

/**
 * Returns a `targetId → mirrorNodeId` map for the cycle returns.
 * One mirror per unique cycle-return `targetId`; mirror ID is the
 * exact target ID with `__mirror` appended.
 */
export function buildMirrorMap(cycleReturnKeys: CycleReturnKeys): Map<string, string> {
  const mirrorIdByTargetId = new Map<string, string>();
  for (const key of cycleReturnKeys) {
    const targetId = key.split('\0')[1];
    if (!mirrorIdByTargetId.has(targetId)) {
      mirrorIdByTargetId.set(targetId, `${targetId}__mirror`);
    }
  }
  return mirrorIdByTargetId;
}

// ─── Step 8: build mirror FlowNodes ──────────────────────────────────────────

/**
 * Builds the FlowNodes for the mirror map. Each mirror:
 *   - has `id` from the map value (e.g. `A__in__2__mirror`),
 *   - carries `data.isMirror: true`,
 *   - carries `data.mirrorOf` (exact split ID) and
 *     `data.mirrorOfBase` (canonical intent ID) for downstream consumers,
 *   - has a label like `A' (in 2)\n<intentName>` if the target was a
 *     split copy, or `A'\n<intentName>` for a non-split target.
 */
export function buildMirrorNodes(
  mirrorIdByTargetId: Map<string, string>,
  intentMap: Map<string, KBIntent>,
  compareIntentId: (a?: string, b?: string) => number,
): FlowNode[] {
  const out: FlowNode[] = [];

  for (const [targetId, mirrorNodeId] of [...mirrorIdByTargetId.entries()].sort((a, b) =>
    compareIntentId(a[0], b[0]),
  )) {
    const splitMatch = targetId.match(/^(.*)__(in|out)__(\d+)$/);
    const mirrorOfBase = splitMatch ? splitMatch[1] : targetId;
    const role = splitMatch ? (splitMatch[2] as 'in' | 'out') : null;
    const index = splitMatch ? Number(splitMatch[3]) : null;

    const intent = intentMap.get(mirrorOfBase);
    let label: string;
    if (role !== null && index !== null) {
      label = intent
        ? `${mirrorOfBase}' (${role} ${index})\n${intent.intentName}`
        : `${mirrorOfBase}' (${role} ${index})`;
    } else {
      label = intent ? `${mirrorOfBase}'\n${intent.intentName}` : `${mirrorOfBase}'`;
    }

    out.push({
      id: mirrorNodeId,
      position: { x: 0, y: 0 },
      data: {
        label,
        rawData: intent,
        isMirror: true,
        mirrorOf: targetId, // exact split node ID
        mirrorOfBase,       // canonical intent ID — for coverage checks
      },
      type: 'default',
    });
  }

  return out;
}

// ─── Step 9: build final FlowEdges ──────────────────────────────────────────

/**
 * Builds the final FlowEdges from the split-resolved edges. Cycle-return
 * edges have their target rewritten to the mirror node; all others pass
 * through. Color is picked from the merged method set on each edge.
 */
export function buildFinalEdges(
  splitEdges: SplitEdge[],
  cycleReturnKeys: CycleReturnKeys,
  mirrorIdByTargetId: Map<string, string>,
  pickEdgeColor: (methods: Set<string>) => string,
): FlowEdge[] {
  const out: FlowEdge[] = [];

  for (const edge of splitEdges) {
    const key = `${edge.sourceId}\0${edge.targetId}`;
    const isCycleReturn = cycleReturnKeys.has(key);
    const finalTarget = isCycleReturn
      ? (mirrorIdByTargetId.get(edge.targetId) ?? `${edge.targetId}__mirror`)
      : edge.targetId;

    const strokeColor = pickEdgeColor(edge.meta.methods);
    out.push({
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

  return out;
}
