import { FlowNode } from './parseKB';
import type { Adjacency, KBIntent } from './parseKB';

// ─── Types shared with the rest of the split/mirror pipeline ─────────────────

/** Per-edge metadata carried over from the original adjacency. */
export interface EdgeMeta {
  labels: Set<string>;
  methods: Set<string>;
  order: number;
}

/** A single edge after its endpoints have been resolved to split-node IDs. */
export interface SplitEdge {
  /** Final node ID on the source side (may be a split copy). */
  sourceId: string;
  /** Final node ID on the target side (may be a split copy). */
  targetId: string;
  /** Canonical intent ID on the source side (pre-split). */
  sourceBase: string;
  /** Canonical intent ID on the target side (pre-split). */
  targetBase: string;
  meta: EdgeMeta;
}

/** Inbound vs outbound split copy. */
export type SplitRole = 'in' | 'out';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Stable ID for a split copy of an intent. */
export function getSplitNodeId(
  intentId: string,
  role: SplitRole,
  index: number,
): string {
  return `${intentId}__${role}__${index}`;
}

// ─── Step 5a: decide which intents need splitting ────────────────────────────

/**
 * Returns the set of intent IDs that should be split into per-edge copies.
 * Triggers when either in-degree or out-degree is `>= 4` AND the other
 * side is non-zero (a one-sided hub like a sink or a source gets no
 * splitting — there's nothing to fan out into).
 */
export function decideSplitIntents(
  sortedUsedIntents: KBIntent[],
  inboundCount: Map<string, number>,
  outboundCount: Map<string, number>,
): Set<string> {
  const splitIntentIds = new Set<string>();
  for (const intent of sortedUsedIntents) {
    const inbound = inboundCount.get(intent.intentId) ?? 0;
    const outbound = outboundCount.get(intent.intentId) ?? 0;
    const splitByInbound = inbound >= 4 && outbound > 0;
    const splitByOutbound = outbound >= 4 && inbound > 0;
    if (splitByInbound || splitByOutbound) {
      splitIntentIds.add(intent.intentId);
    }
  }
  return splitIntentIds;
}

// ─── Step 5b: push the per-intent nodes (split or non-split) ─────────────────

/**
 * Returns the FlowNodes for the supplied intents. Non-split intents
 * produce one node each. Split intents produce `inboundTotal` 'in' copies
 * + `outboundTotal` 'out' copies. The first intent (if any) gets a ▶
 * arrow prefix on its first copy.
 */
export function buildSplitNodes(
  sortedUsedIntents: KBIntent[],
  splitIntentIds: Set<string>,
  inboundCount: Map<string, number>,
  outboundCount: Map<string, number>,
  firstIntentId: string | null,
): FlowNode[] {
  const out: FlowNode[] = [];

  for (const intent of sortedUsedIntents) {
    const isSplit = splitIntentIds.has(intent.intentId);
    const isFirst = intent.intentId === firstIntentId;
    const arrow = isFirst ? '▶ ' : '';

    if (!isSplit) {
      out.push({
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
      out.push({
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
      out.push({
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

  return out;
}

// ─── Step 5c: resolve adjacency into split-edge pairs ────────────────────────

/**
 * Walks the original adjacency and rewrites each edge's source/target to
 * the corresponding split-node ID. The output `SplitEdge` carries both
 * the resolved IDs and the canonical base IDs so downstream steps
 * (cycle detection, mirror generation) can use either.
 *
 * Split copy assignment: each outbound edge from a split intent consumes
 * the next `__out__N` index, in adjacency order. Each inbound edge to a
 * split intent consumes the next `__in__N` index, in adjacency order.
 */
export function resolveSplitEdges(
  adjacency: Adjacency,
  splitIntentIds: Set<string>,
): SplitEdge[] {
  const outboundIndexBySource = new Map<string, number>();
  const inboundIndexByTarget = new Map<string, number>();
  const out: SplitEdge[] = [];

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
      out.push({ sourceId, targetId, sourceBase: source, targetBase: target, meta });
    }
  }

  return out;
}

// ─── Convenience: count in/out degrees from adjacency ────────────────────────

/**
 * Computes in-degree and out-degree maps from the adjacency. Used by
 * `decideSplitIntents` and by the mirror-DFS step.
 */
export function countDegrees(
  adjacency: Adjacency,
): { inboundCount: Map<string, number>; outboundCount: Map<string, number> } {
  const inboundCount = new Map<string, number>();
  const outboundCount = new Map<string, number>();
  for (const [source, targets] of adjacency) {
    outboundCount.set(source, targets.size);
    for (const target of targets.keys()) {
      inboundCount.set(target, (inboundCount.get(target) ?? 0) + 1);
    }
  }
  return { inboundCount, outboundCount };
}
