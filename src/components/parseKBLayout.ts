import { FlowNode, FlowEdge } from './parseKB';
import type { KBIntent } from './parseKB';

// ─── Layout constants ────────────────────────────────────────────────────────

/** Width of a single rendered intent node in the graph. */
export const NODE_WIDTH  = 240;
/** Height of a single rendered intent node in the graph. */
export const NODE_HEIGHT = 70;
/** Horizontal gap between sibling nodes. */
export const H_GAP       = 80;
/** Vertical gap between levels. */
export const V_GAP       = 100;

// ─── Edge index ───────────────────────────────────────────────────────────────

/** Outgoing adjacency: source intentId → list of target intentIds. */
export type OutgoingAdjacency = Map<string, string[]>;
/** Incoming in-degree: target intentId → count of edges in. */
export type IncomingCounts = Map<string, number>;

/**
 * Builds the two adjacency lookups needed for BFS layout from the
 * current node + edge list. Drops edges that reference missing nodes.
 */
export function buildEdgeIndex(
  nodes: FlowNode[],
  edges: FlowEdge[],
): { incomingCount: IncomingCounts; outgoing: OutgoingAdjacency } {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const incomingCount: IncomingCounts = new Map();
  const outgoing: OutgoingAdjacency = new Map();

  for (const node of nodes) {
    incomingCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)!.push(edge.target);
  }

  return { incomingCount, outgoing };
}

// ─── Root selection ───────────────────────────────────────────────────────────

/**
 * Picks the set of "root" intent IDs to start the BFS from, in priority
 * order:
 *   1. Explicit root intents (parentId === 'ROOT' / null) that are
 *      present in the graph.
 *   2. Nodes with in-degree 0 (disconnected entry points).
 *   3. Fallback: the first sorted intent that's in the graph.
 */
export function findRoots(
  sortedIntents: KBIntent[],
  allIntents: KBIntent[],
  incomingCount: IncomingCounts,
  nodeMap: Map<string, FlowNode>,
): string[] {
  const inGraph = (id: string) => nodeMap.has(id);

  const explicitRoots = allIntents
    .filter(
      (i) => (i.parentId === 'ROOT' || i.parentId == null) && inGraph(i.intentId),
    )
    .map((i) => i.intentId);

  if (explicitRoots.length > 0) return explicitRoots;

  const inDegreeRoots = sortedIntents
    .filter(
      (i) => inGraph(i.intentId) && (incomingCount.get(i.intentId) ?? 0) === 0,
    )
    .map((i) => i.intentId);

  if (inDegreeRoots.length > 0) return inDegreeRoots;

  return sortedIntents.filter((i) => inGraph(i.intentId)).map((i) => i.intentId).slice(0, 1);
}

// ─── BFS depth assignment ─────────────────────────────────────────────────────

/**
 * BFS from the supplied roots. Each visited node gets the maximum depth
 * along any path from a root, so cyclic graphs place nodes at the deepest
 * known level rather than the first one visited.
 */
export function bfsDepths(
  roots: string[],
  outgoing: OutgoingAdjacency,
): Map<string, number> {
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

  return depth;
}

/**
 * Mutates `depth` so every node in `nodes` has an entry. Nodes not
 * reachable from any root (orphans, members of cycles broken off from
 * roots) get placed one level past the current max depth.
 */
export function assignOrphanDepths(
  depth: Map<string, number>,
  nodes: FlowNode[],
): void {
  let maxDepth = 0;
  depth.forEach((d) => {
    if (d > maxDepth) maxDepth = d;
  });
  for (const node of nodes) {
    if (!depth.has(node.id)) depth.set(node.id, maxDepth + 1);
  }
}

// ─── Level bucketing + positioning ────────────────────────────────────────────

/**
 * Buckets the nodes by their depth value, preserving `sortedIntents` order
 * within each level so siblings render in the same order as in the KB.
 */
export function bucketByDepth(
  sortedIntents: KBIntent[],
  depth: Map<string, number>,
  nodeMap: Map<string, FlowNode>,
): Map<number, FlowNode[]> {
  const levels = new Map<number, FlowNode[]>();
  for (const intent of sortedIntents) {
    const node = nodeMap.get(intent.intentId);
    if (!node) continue;
    const lvl = depth.get(intent.intentId) ?? 0;
    const list = levels.get(lvl) ?? [];
    list.push(node);
    levels.set(lvl, list);
  }
  return levels;
}

/**
 * Centers each level horizontally around x=0 and stacks levels vertically
 * using `V_GAP`. Mutates `node.position` on every node in every level.
 */
export function positionLevels(levels: Map<number, FlowNode[]>): void {
  levels.forEach((levelNodes, level) => {
    const totalWidth =
      levelNodes.length * NODE_WIDTH + (levelNodes.length - 1) * H_GAP;
    const startX = -totalWidth / 2;
    levelNodes.forEach((node, index) => {
      node.position = {
        x: startX + index * (NODE_WIDTH + H_GAP),
        y: level * (NODE_HEIGHT + V_GAP),
      };
    });
  });
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

/**
 * Lays out an action-based graph in a top-down, BFS-ordered grid. The
 * graph is assumed to be acyclic for "nice" layouts; cycles and orphans
 * are handled but the result is best-effort.
 */
export function layoutActionGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  sortedIntents: KBIntent[],
  allIntents: KBIntent[],
): void {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const { incomingCount, outgoing } = buildEdgeIndex(nodes, edges);
  const roots = findRoots(sortedIntents, allIntents, incomingCount, nodeMap);
  const depth = bfsDepths(roots, outgoing);
  assignOrphanDepths(depth, nodes);
  const levels = bucketByDepth(sortedIntents, depth, nodeMap);
  positionLevels(levels);
}
