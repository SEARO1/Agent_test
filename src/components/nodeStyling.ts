import { Edge, Node } from '@xyflow/react';
import React from 'react';

// ─── Shared context types ────────────────────────────────────────────────────

/** Per-node style decision context. */
export interface NodeStyleContext {
  isSearchHit: boolean;
  isClickHighlighted: boolean;
  isFirstIntent: boolean;
  isMirror: boolean;
  clickActive: boolean;
}

/** Per-edge style decision context. */
export interface EdgeStyleContext {
  clickActive: boolean;
  isClickHighlighted: boolean;
}

/** Context needed to pick a MiniMap node color. */
export interface MiniMapColorContext {
  firstIntentNodeId: string | null;
  currentSearchNodeId: string | null;
  clickActive: boolean;
  clickHighlightedNodeIds: Set<string>;
  highlightedNodeIds: Set<string>;
}

// ─── Mirror base style (applied to ALL nodes) ────────────────────────────────

/**
 * The `mirror` branch needs to live in the *base* style (not an
 * override) so it composes with click/search/first-intent layers. Every
 * node goes through this so the final spread is consistent.
 */
function getMirrorBaseStyle(): React.CSSProperties {
  return {
    background: '#f8fafc',
    border: '2px dashed #94a3b8',
    borderRadius: '4px',
    fontStyle: 'italic',
  };
}

// ─── Node decoration ─────────────────────────────────────────────────────────

/**
 * Returns the React Flow `style` overrides to apply to a node given its
 * current display state. Returns `null` if no overrides are needed (the
 * node should keep its base style as-is).
 *
 * Visual priority (top-down):
 *   1. click-highlighted  → cyan halo (overrides everything else)
 *   2. click-dimmed       → opacity 0.15 (rest of graph while a selection is active)
 *   3. search hit         → yellow halo
 *   4. first intent       → amber halo (entry-point marker)
 *   5. default            → no change
 */
export function getNodeStyleOverrides(ctx: NodeStyleContext): React.CSSProperties | null {
  if (ctx.isClickHighlighted) {
    return {
      background: '#cffafe',
      border: ctx.isSearchHit ? '2px solid #0e7490' : '2px solid #06b6d4',
      borderRadius: '4px',
      boxShadow: '0 0 0 4px rgba(6, 182, 212, 0.25)',
      zIndex: 10,
    };
  }

  if (ctx.clickActive) {
    return { opacity: 0.15 };
  }

  if (ctx.isSearchHit) {
    return {
      background: '#fef08a',
      border: '2px solid #eab308',
      borderRadius: '4px',
      zIndex: 10,
    };
  }

  if (ctx.isFirstIntent) {
    return {
      background: '#fef3c7',
      border: '2px solid #f59e0b',
      borderRadius: '4px',
      boxShadow: '0 0 0 4px rgba(245, 158, 11, 0.25)',
      zIndex: 10,
    };
  }

  return null;
}

/**
 * Returns a new node with the appropriate style applied for its current
 * display state. If the node is a mirror, the mirror base style is spread
 * first so that override branches compose on top.
 */
export function decorateNode<N extends Node>(node: N, ctx: NodeStyleContext): N {
  const baseFromNode = (node.style ?? {}) as React.CSSProperties;
  const baseStyle = ctx.isMirror
    ? { ...baseFromNode, ...getMirrorBaseStyle() }
    : baseFromNode;

  const overrides = getNodeStyleOverrides(ctx);
  if (overrides === null) {
    // Mirror nodes still need their base style to be applied.
    if (ctx.isMirror) {
      return { ...node, style: baseStyle } as N;
    }
    return node;
  }
  return { ...node, style: { ...baseStyle, ...overrides } } as N;
}

// ─── Edge decoration ─────────────────────────────────────────────────────────

/** Per-edge override. `style` is required, `animated` and `zIndex` are optional. */
export interface EdgeStyleOverride {
  style: React.CSSProperties;
  animated?: boolean;
  zIndex?: number;
}

/**
 * Returns React Flow overrides for an edge given its display state.
 * Returns `null` if no overrides are needed (no active selection).
 */
export function getEdgeStyleOverrides(ctx: EdgeStyleContext): EdgeStyleOverride | null {
  if (!ctx.clickActive) return null;

  if (ctx.isClickHighlighted) {
    return {
      style: { strokeWidth: 3, opacity: 1 },
      animated: false,
      zIndex: 5,
    };
  }

  return { style: { opacity: 0.1 } };
}

/** Returns a new edge with the appropriate style applied. */
export function decorateEdge<E extends Edge>(edge: E, ctx: EdgeStyleContext): E {
  const overrides = getEdgeStyleOverrides(ctx);
  if (overrides === null) return edge;
  const baseStyle = (edge.style ?? {}) as React.CSSProperties;
  return {
    ...edge,
    style: { ...baseStyle, ...overrides.style },
    ...(overrides.animated !== undefined ? { animated: overrides.animated } : {}),
    ...(overrides.zIndex !== undefined ? { zIndex: overrides.zIndex } : {}),
  } as E;
}

// ─── MiniMap node color ──────────────────────────────────────────────────────

/**
 * Picks a MiniMap color for a node based on the current display context.
 * Priority order:
 *   1. First-intent (entry point)        → amber
 *   2. Current search-result focus       → yellow
 *   3. Click-highlighted                 → cyan
 *   4. Mirror                            → gray
 *   5. Node type fallback                → blue / red / green
 */
export function getMiniMapNodeColor(node: Node, ctx: MiniMapColorContext): string {
  if (node.id === ctx.firstIntentNodeId) return '#f59e0b';
  if (node.id === ctx.currentSearchNodeId) return '#eab308';
  if (ctx.clickActive && ctx.clickHighlightedNodeIds.has(node.id)) return '#06b6d4';
  if ((node.data as { isMirror?: boolean } | undefined)?.isMirror) return '#94a3b8';

  switch (node.type) {
    case 'input':
      return '#61dafb';
    case 'output':
      return '#ff6b6b';
    default:
      return ctx.highlightedNodeIds.has(node.id) ? '#fef08a' : '#c8e6c9';
  }
}
