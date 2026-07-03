import { useMemo, useRef, useEffect, useCallback, useState } from 'react';
import ForceGraph3D, {
  ForceGraphMethods,
  NodeObject,
  LinkObject,
} from 'react-force-graph-3d';
import * as THREE from 'three';
import { FlowNode, FlowEdge } from './parseKB';

// ── Props ────────────────────────────────────────────────────────────────────

interface Props {
  initialNodes: FlowNode[];
  initialEdges: FlowEdge[];
  searchResults?: FlowNode[];
  currentResultIndex?: number;
}

// ── Colour palette (mirrors parseKB.ts) ──────────────────────────────────────

const EDGE_COLORS: Record<string, string> = {
  dtmf:     '#10b981',
  noh:      '#f43f5e',
  followUp: '#f59e0b',
  redirect: '#3b82f6',
  procArg:  '#8b5cf6',
};

const DEFAULT_EDGE_COLOR = '#b1b1b7';
const ENTRY_NODE_COLOR    = '#f59e0b';
const SEARCH_HIT_COLOR    = '#eab308';
const NODE_DEFAULT_COLOR  = '#61dafb';
const MIRROR_NODE_COLOR   = '#94a3b8';

// ── Node label sprite (canvas-based, always visible) ────────────────────────

function makeNodeSprite(
  label: string,
  isEntry: boolean,
  isSearchHit: boolean,
  isMirror: boolean,
): THREE.Sprite {
  const lines = label.split('\n');
  const fontSize = 28;
  const lineHeight = fontSize * 1.3;
  const padding = 8;
  const width = 260;
  const height = lines.length * lineHeight + padding * 2;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  // Background
  let bg = '#ffffff';
  if (isEntry)       bg = '#fef3c7';
  else if (isMirror) bg = '#f8fafc';

  ctx.fillStyle = bg;
  ctx.strokeStyle = isEntry ? '#f59e0b' : isMirror ? '#94a3b8' : '#d0d0d0';
  ctx.lineWidth = isEntry ? 3 : isMirror ? 2 : 1;
  const r = 8;
  roundRect(ctx, 0, 0, width, height, r);
  ctx.fill();
  ctx.stroke();

  // Search highlight ring
  if (isSearchHit) {
    ctx.strokeStyle = '#eab308';
    ctx.lineWidth = 3;
    roundRect(ctx, 2, 2, width - 4, height - 4, r);
    ctx.stroke();
  }

  // Text
  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) => {
    ctx.fillText(line, width / 2, padding + i * lineHeight);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(width / 20, height / 20, 1);
  return sprite;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ── Edge label sprite (smaller, shown mid-link) ─────────────────────────────

function makeEdgeLabelSprite(label: string, color: string): THREE.Sprite {
  const fontSize = 22;
  const padding = 6;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  const metrics = ctx.measureText(label);
  const width = metrics.width + padding * 2;
  const height = fontSize + padding * 2;
  canvas.width = width;
  canvas.height = height;

  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 0, 0, width, height, 4);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  roundRect(ctx, 0.5, 0.5, width - 1, height - 1, 4);
  ctx.stroke();

  ctx.font = `bold ${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, width / 2, height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const spriteMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(spriteMaterial);
  sprite.scale.set(width / 16, height / 16, 1);
  return sprite;
}

// ── Helper: detect edge method colour from label ────────────────────────────

function inferEdgeColor(label: string): string {
  const lower = label.toLowerCase();
  if (lower === 'dtmf' || lower.startsWith('[')) return EDGE_COLORS.dtmf;
  if (lower === 'noh')                          return EDGE_COLORS.noh;
  if (lower === 'followup')                     return EDGE_COLORS.followUp;
  if (lower === 'redirect')                     return EDGE_COLORS.redirect;
  if (lower.startsWith('success') || lower.startsWith('failure') || lower.startsWith('intent'))
    return EDGE_COLORS.procArg;
  return DEFAULT_EDGE_COLOR;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function ForceGraph3DView({
  initialNodes,
  initialEdges,
  searchResults = [],
  currentResultIndex = 0,
}: Props) {
  const fgRef = useRef<ForceGraphMethods | undefined>(undefined);
  const [highlightNodeId, setHighlightNodeId] = useState<string | null>(null);

  // First intent (entry point)
  const firstIntentNodeId = useMemo(
    () => initialNodes.find((n) => n.data?.isFirstIntent)?.id ?? null,
    [initialNodes],
  );

  // Search-hit node IDs
  const searchHitIds = useMemo(
    () => new Set(searchResults.map((n) => n.id)),
    [searchResults],
  );

  const currentSearchNode = searchResults[currentResultIndex];

  // Convert FlowNodes to 3D graph format
  const graphData = useMemo(() => {
    const nodes = initialNodes.map((n) => ({
      id: n.id,
      label: n.data?.label ?? n.id,
      isFirstIntent: n.id === firstIntentNodeId,
      isSearchHit: searchHitIds.has(n.id),
      isMirror: Boolean((n.data as { isMirror?: boolean } | undefined)?.isMirror),
      type: n.type,
    }));

    // Edge labels combined (grouped by source/target with label aggregation)
    const edgeLabelMap = new Map<string, string[]>();
    for (const e of initialEdges) {
      const key = `${e.source}|${e.target}`;
      if (!edgeLabelMap.has(key)) edgeLabelMap.set(key, []);
      if (e.label) edgeLabelMap.get(key)!.push(e.label);
    }

    const links = initialEdges.map((e) => {
      const key = `${e.source}|${e.target}`;
      const labels = edgeLabelMap.get(key) ?? [];
      const edgeLabel = labels.join(', ');
      return {
        source: e.source,
        target: e.target,
        label: edgeLabel,
        color: e.style?.stroke ?? (edgeLabel ? inferEdgeColor(edgeLabel) : DEFAULT_EDGE_COLOR),
      };
    });

    return { nodes, links };
  }, [initialNodes, initialEdges, firstIntentNodeId, searchHitIds]);

  // Auto-zoom to fit on initial load
  useEffect(() => {
    if (fgRef.current && graphData.nodes.length > 0) {
      setTimeout(() => {
        fgRef.current?.zoomToFit(400, 40);
      }, 500);
    }
  }, [graphData.nodes.length]);

  // Center on search result node
  useEffect(() => {
    if (fgRef.current && currentSearchNode) {
      const node = graphData.nodes.find((n) => n.id === currentSearchNode.id);
      if (node && node.x !== undefined && node.y !== undefined && node.z !== undefined) {
        fgRef.current.cameraPosition(
          { x: node.x * 1.5, y: node.y * 1.5, z: node.z * 1.5 + 300 },
          { x: node.x, y: node.y, z: node.z },
          500,
        );
      }
    }
  }, [currentSearchNode, graphData.nodes]);

  const handleNodeClick = useCallback(
    (node: NodeObject) => {
      setHighlightNodeId((prev) => (prev === node.id ? null : (node.id as string)));
    },
    [],
  );

  const handleBackgroundClick = useCallback(() => {
    setHighlightNodeId(null);
  }, []);

  return (
    <ForceGraph3D
      ref={fgRef}
      graphData={graphData}
      backgroundColor="#fafafa"
      showNavInfo={false}
      // DAG layout — top-down
      dagMode="td"
      dagLevelDistance={100}
      nodeRelSize={6}
      nodeLabel={(node: NodeObject) => {
        const n = node as any;
        let info = `<b>${n.label}</b>`;
        if (n.isFirstIntent) info += '<br/>⏵ Entry Point';
        if (n.isMirror) info += '<br/>↻ Mirror';
        return info;
      }}
      nodeColor={(node: NodeObject) => {
        const n = node as any;
        if (highlightNodeId && n.id !== highlightNodeId) return '#ccc';
        if (n.isFirstIntent) return ENTRY_NODE_COLOR;
        if (n.isSearchHit)   return SEARCH_HIT_COLOR;
        if (n.isMirror)      return MIRROR_NODE_COLOR;
        return NODE_DEFAULT_COLOR;
      }}
      nodeThreeObject={(node: NodeObject) => {
        const n = node as any;
        return makeNodeSprite(n.label, n.isFirstIntent, n.isSearchHit, n.isMirror);
      }}
      linkColor={(link: LinkObject) => {
        const l = link as any;
        if (highlightNodeId) {
          const isConnected =
            l.source?.id === highlightNodeId || l.target?.id === highlightNodeId;
          return isConnected ? l.color : '#eee';
        }
        return l.color;
      }}
      linkWidth={(link: LinkObject) => {
        const l = link as any;
        if (highlightNodeId) {
          const isConnected =
            l.source?.id === highlightNodeId || l.target?.id === highlightNodeId;
          return isConnected ? 2 : 0.3;
        }
        return 1.2;
      }}
      linkOpacity={0.7}
      linkDirectionalArrowLength={8}
      linkDirectionalArrowRelPos={0.95}
      linkThreeObject={(link: LinkObject) => {
        const l = link as any;
        if (!l.label) return null;
        return makeEdgeLabelSprite(l.label, l.color);
      }}
      linkThreeObjectExtend={false}
      onNodeClick={handleNodeClick}
      onBackgroundClick={handleBackgroundClick}
      enableNodeDrag={true}
      enableNavigationControls={true}
      cooldownTicks={50}
      warmupTicks={10}
    />
  );
}
