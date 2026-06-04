import ELK from 'elkjs/lib/elk.bundled.js';
import { FlowNode, FlowEdge } from './parseKB';

// ─── ELK configuration ───────────────────────────────────────────────────────

/** Default node size used when handing the graph off to ELK. */
export const ELK_NODE_WIDTH = 250;
export const ELK_NODE_HEIGHT = 80;

/** Layout direction. `'TB'` = top-to-bottom, `'LR'` = left-to-right. */
export type LayoutDirection = 'TB' | 'LR';

const ELK_LAYOUT_OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.spacing.nodeNode': '100',
  'elk.layered.spacing.nodeNodeBetweenLayers': '150',
  'elk.edgeRouting': 'POLYLINE',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
} as const;

// ─── ELK input/output shapes ─────────────────────────────────────────────────

interface ElkInputNode extends Record<string, unknown> {
  id: string;
  width: number;
  height: number;
}

interface ElkInputEdge extends Record<string, unknown> {
  id: string;
  sources: string[];
  targets: string[];
}

interface ElkInputGraph {
  id: string;
  layoutOptions: Record<string, string>;
  children: ElkInputNode[];
  edges: ElkInputEdge[];
}

interface ElkOutputChild {
  id: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ElkOutputGraph {
  children?: ElkOutputChild[];
}

const elk = new ELK();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Builds the ELK input graph from React Flow nodes/edges for the given direction. */
export function buildElkGraph(
  nodes: FlowNode[],
  edges: FlowEdge[],
  dir: LayoutDirection = 'TB',
): ElkInputGraph {
  const isHorizontal = dir === 'LR';
  return {
    id: 'root',
    layoutOptions: {
      ...ELK_LAYOUT_OPTIONS,
      'elk.direction': isHorizontal ? 'RIGHT' : 'DOWN',
    },
    children: nodes.map((n) => ({
      ...n,
      id: n.id,
      width: ELK_NODE_WIDTH,
      height: ELK_NODE_HEIGHT,
    })),
    edges: edges.map((e) => ({
      ...e,
      id: e.id,
      sources: [e.source],
      targets: [e.target],
    })),
  };
}

/** Runs ELK layout and returns just the positioned children. */
export async function applyElkLayout(graph: ElkInputGraph): Promise<ElkOutputGraph> {
  return (await elk.layout(graph as unknown as Parameters<typeof elk.layout>[0])) as ElkOutputGraph;
}

/**
 * Lays out the supplied nodes/edges with ELK. On any layout error the
 * original positions are preserved so the graph still renders.
 */
export async function getLayoutedElements(
  nodes: FlowNode[],
  edges: FlowEdge[],
  dir: LayoutDirection = 'TB',
): Promise<{ nodes: FlowNode[]; edges: FlowEdge[] }> {
  try {
    const graph = buildElkGraph(nodes, edges, dir);
    const layouted = await applyElkLayout(graph);

    const layoutedNodes = nodes.map((node) => {
      const layoutNode = layouted.children?.find((n) => n.id === node.id);
      return {
        ...node,
        position: {
          x: layoutNode?.x ?? 0,
          y: layoutNode?.y ?? 0,
        },
      };
    });

    return { nodes: layoutedNodes, edges };
  } catch (error) {
    console.error('ELK Layout Error:', error);
    return { nodes, edges };
  }
}
