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

// ── Colour palette ───────────────────────────────────────────────────────────

const EDGE_COLORS: Record<string, string> = {
  dtmf:     '#10b981',
  noh:      '#f43f5e',
  followUp: '#f59e0b',
  redirect: '#3b82f6',
  procArg:  '#8b5cf6',
};

const DEFAULT_EDGE_COLOR = '#b1b1b7';

const NODE_COLORS: Record<string, number> = {
  default:  0x61dafb,
  entry:    0xf59e0b,
  search:   0xeab308,
  mirror:   0x94a3b8,
  collapsed:0x888888,
  dimmed:   0x444444,
};

// ── Low-poly sphere (20×20 segments — lighter than default 24×24) ──────────

function makeSphereNode(
  color: number,
  radius: number,
  isEntry: boolean,
  isSearchHit: boolean,
  isMirror: boolean,
  isDimmed: boolean,
  isCollapsed: boolean,
): THREE.Group {
  const group = new THREE.Group();

  const geo = new THREE.SphereGeometry(radius, 16, 12);
  const mat = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.1,
    roughness: 0.4,
    emissive: isEntry ? new THREE.Color(0xf59e0b) : new THREE.Color(0x000000),
    emissiveIntensity: isEntry ? 0.12 : 0,
    transparent: isDimmed,
    opacity: isDimmed ? 0.2 : 1,
  });
  const sphere = new THREE.Mesh(geo, mat);
  group.add(sphere);

  // Collapsed indicator — hollow sphere (stroke-only wireframe) + dashed ring
  if (isCollapsed) {
    // Outer stroke sphere (wireframe) — makes it clearly "empty"
    const strokeGeo = new THREE.SphereGeometry(radius * 1.4, 12, 8);
    const strokeMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      wireframe: true,
      transparent: true,
      opacity: 0.25,
    });
    const strokeSphere = new THREE.Mesh(strokeGeo, strokeMat);
    group.add(strokeSphere);

    // Prominent ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.6, 1.5, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }),
    );
    ring.rotation.x = Math.PI / 2;
    group.add(ring);

    // Second perpendicular ring for clearer "collapsed" signal
    const ring2 = ring.clone();
    ring2.rotation.z = Math.PI / 2;
    ring2.material = ring.material.clone();
    (ring2.material as THREE.MeshBasicMaterial).opacity = 0.3;
    group.add(ring2);
  }

  // Entry glow ring
  if (isEntry) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(radius * 0.9, radius * 1.2, 24),
      new THREE.MeshBasicMaterial({ color: 0xf59e0b, side: THREE.DoubleSide, transparent: true, opacity: 0.2 }),
    );
    r.rotation.x = Math.PI / 2;
    group.add(r);
  }

  // Search hit ring
  if (isSearchHit) {
    const r = new THREE.Mesh(
      new THREE.RingGeometry(radius * 1.1, radius * 1.35, 24),
      new THREE.MeshBasicMaterial({ color: 0xeab308, side: THREE.DoubleSide, transparent: true, opacity: 0.3 }),
    );
    r.rotation.x = Math.PI / 2;
    group.add(r);
  }

  // Mirror: dashed torus (more visible)
  if (isMirror) {
    const r = new THREE.Mesh(
      new THREE.TorusGeometry(radius * 1.4, 1.2, 8, 20),
      new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.7 }),
    );
    r.rotation.x = Math.PI / 2;
    group.add(r);
  }

  return group;
}

// ── Collapse/expand helpers: figure out which node IDs to show ───────────────

type ExpandState = Set<string>; // set of expanded node IDs

// ── Extract base intent ID (strip split/mirror suffixes) ─────────────────
function getBaseIntentId(nodeId: string): string {
  const m = nodeId.match(/^(.*)__(in|out)__\d+$/);
  if (m) return m[1];
  const mirror = nodeId.match(/^(.+?)__mirror$/);
  if (mirror) return getBaseIntentId(mirror[1]); // recurse for mirror-of-mirror
  return nodeId;
}
function isSplitNode(nodeId: string): boolean {
  return /__in__\d+$|__out__\d+$/.test(nodeId);
}
function isMirrorNode(nodeId: string): boolean {
  return /__mirror$/.test(nodeId);
}

// ── Compute DAG depth: base-level hierarchy, then derive split depths ───
function computeNodeDepth(
  allNodes: FlowNode[],
  edges: FlowEdge[],
  rootIds: string[],
): Map<string, number> {
  const depth = new Map<string, number>();

  // Step 1: Build base-level adjacency (strip split/mirror from edge IDs)
  const baseAdj = new Map<string, string[]>();
  const allBaseIds = new Set(allNodes.map(n => getBaseIntentId(n.id)));
  for (const id of allBaseIds) baseAdj.set(id, []);

  for (const e of edges) {
    const srcBase = getBaseIntentId(e.source);
    const tgtBase = getBaseIntentId(e.target);
    if (srcBase === tgtBase) continue; // skip self-loops (within same intent)
    if (!allBaseIds.has(srcBase) || !allBaseIds.has(tgtBase)) continue;
    if (!baseAdj.get(srcBase)!.includes(tgtBase)) {
      baseAdj.get(srcBase)!.push(tgtBase);
    }
  }

  // Step 2: Find TRUE root base IDs from collapsed graph (not from raw rootIds)
  // Raw edges target split nodes (e.g. billing__in__1), so billing itself
  // appears to have no inbound edge. We recompute inbound from base-level edges.
  const baseInbound = new Set<string>();
  for (const e of edges) {
    const tgtBase = getBaseIntentId(e.target);
    if (tgtBase !== getBaseIntentId(e.source)) baseInbound.add(tgtBase);
  }
  const explicitFirstIntents = [...new Set(rootIds
    .filter(r => { const n = allNodes.find(nn => nn.id === r); return n?.data?.isFirstIntent; })
    .map(r => getBaseIntentId(r)))];
  // Roots = base IDs with no inbound edges at base level, PLUS explicit first intents
  const trueRootBaseIds = [...allBaseIds].filter(id => !baseInbound.has(id));
  // Ensure explicit first intents are included even if they have inbound edges
  for (const id of explicitFirstIntents) {
    if (!trueRootBaseIds.includes(id)) trueRootBaseIds.push(id);
  }
  // [debug] depth root base IDs and adjacency logged here

  // BFS from true roots
  const queue: string[] = [];
  for (const r of trueRootBaseIds) { depth.set(r, 0); queue.push(r); }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = (depth.get(cur) ?? 0) + 1;
    for (const child of baseAdj.get(cur) ?? []) {
      if (!depth.has(child) || depth.get(child)! > d) {
        depth.set(child, d);
        queue.push(child);
      }
    }
  }
  // [debug] base-level depths logged here

  // Any base IDs not reached → default depth 0
  for (const id of allBaseIds) {
    if (!depth.has(id)) depth.set(id, 0);
  }

  // Step 3: Assign depth to split/mirror nodes: baseDepth + 1
  for (const node of allNodes) {
    if (!depth.has(node.id)) {
      const baseId = getBaseIntentId(node.id);
      const baseDepth = depth.get(baseId) ?? 0;
      if (isSplitNode(node.id) || isMirrorNode(node.id)) {
        depth.set(node.id, baseDepth + 1);
      } else {
        depth.set(node.id, baseDepth);
      }
    }
  }

  return depth;
}

// ── Sub-cluster grouping: assign each depth-2/3 node to a parent's angular range ─
function computeSubClusterRanges(
  allNodes: FlowNode[],
  edges: FlowEdge[],
  depthMap: Map<string, number>,
): Map<string, { parentBaseId: string; angleCenter: number; angleWidth: number }> {
  // Step 1: Map each depth-2 node to its depth-1 parent (base ID)
  // For split/mirror nodes: base ID = parent (e.g. billing__in__1 → billing)
  // For non-split nodes: find via edge (e.g. invoice → billing via billing→invoice edge)
  const result = new Map<string, { parentBaseId: string; angleCenter: number; angleWidth: number }>();
  const childrenOfParent = new Map<string, string[]>(); // baseId → [nodeId...]

  // Helper: get depth-1 parent base from edges
  for (const e of edges) {
    const srcDepth = depthMap.get(e.source);
    const tgtDepth = depthMap.get(e.target);
    if ((srcDepth === 0 || srcDepth === 1) && tgtDepth === 2) {
      const parentBase = getBaseIntentId(e.source);
      if (!childrenOfParent.has(parentBase)) childrenOfParent.set(parentBase, []);
      if (!childrenOfParent.get(parentBase)!.includes(e.target)) {
        childrenOfParent.get(parentBase)!.push(e.target);
      }
    }
  }

  // Also assign split/mirror nodes by base ID
  for (const node of allNodes) {
    if (depthMap.get(node.id) !== 2) continue;
    if (isSplitNode(node.id) || isMirrorNode(node.id)) {
      const base = getBaseIntentId(node.id);
      // Find which depth-1 parent this base belongs to
      // e.g. billing__in__1 → base='billing' → parent=first depth-1 node with that base
      for (const [parentBase, children] of childrenOfParent) {
        if (parentBase === base && !children.includes(node.id)) {
          children.push(node.id);
          break;
        }
      }
      // If no parent found via edges, check if the base itself is depth-1
      if (![...childrenOfParent.values()].some(ch => ch.includes(node.id))) {
        const parentDepth = depthMap.get(base);
        if (parentDepth === 1) {
          if (!childrenOfParent.has(base)) childrenOfParent.set(base, []);
          if (!childrenOfParent.get(base)!.includes(node.id)) {
            childrenOfParent.get(base)!.push(node.id);
          }
        }
      }
    }
  }

  // Step 2: Assign angular ranges to each parent group
  const parentEntries = [...childrenOfParent.entries()].filter(([_, ch]) => ch.length > 0);
  const totalChildren = parentEntries.reduce((sum, [_, ch]) => sum + ch.length, 0);
  let currentAngle = 0;

  for (const [parentBase, children] of parentEntries) {
    const fraction = children.length / totalChildren;
    const angleWidth = fraction * Math.PI * 2 * 0.85; // 85% of circle, leave gaps
    const angleCenter = currentAngle + angleWidth / 2;
    for (const childId of children) {
      result.set(childId, { parentBaseId: parentBase, angleCenter, angleWidth });
    }
    currentAngle += angleWidth + (Math.PI * 2 * 0.15 / parentEntries.length); // distribute gaps
  }

  return result;
}

function computeVisibleNodes(
  allNodes: FlowNode[],
  edges: FlowEdge[],
  expanded: ExpandState,
): { visibleNodeIds: Set<string>; rootIds: string[] } {
  // Build adjacency: parent -> children (incoming edges by parent)
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
    childrenOf.get(e.source)!.push(e.target);
  }

  // Find root candidates: nodes with no inbound edge
  const hasInbound = new Set(edges.map((e) => e.target));
  const rootIds = allNodes
    .filter((n) => !hasInbound.has(n.id) || n.data?.isFirstIntent)
    .map((n) => n.id);

  const visible = new Set<string>();
  const queue = [...rootIds];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    visible.add(id);
    if (expanded.has(id)) {
      const children = childrenOf.get(id) ?? [];
      for (const c of children) {
        if (!visited.has(c)) queue.push(c);
      }
    }
  }
  return { visibleNodeIds: visible, rootIds };
}

// ── Helper: detect edge colour from label ────────────────────────────────────

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
  const [expanded, setExpanded] = useState<ExpandState>(() => new Set<string>());

  // First intent (entry point)
  const firstIntentNodeId = useMemo(
    () => initialNodes.find((n) => n.data?.isFirstIntent)?.id ?? null,
    [initialNodes],
  );

  const searchHitIds = useMemo(
    () => new Set(searchResults.map((n) => n.id)),
    [searchResults],
  );

  const currentSearchNode = searchResults[currentResultIndex];

  // ── Compute visible subset of nodes/edges ─────────────────────────────────
  const { visibleNodeIds, rootIds } = useMemo(
    () => computeVisibleNodes(initialNodes, initialEdges, expanded),
    [initialNodes, initialEdges, expanded],
  );

  const visibleGraph = useMemo(() => {
    const nodes = initialNodes.filter((n) => visibleNodeIds.has(n.id));
    const edges = initialEdges.filter((e) => visibleNodeIds.has(e.source) && visibleNodeIds.has(e.target));

    // Depth: BFS from roots
    const depthMap = computeNodeDepth(initialNodes, initialEdges, rootIds);

    const nodeData = nodes.map((n) => ({
      id: n.id,
      label: n.data?.label ?? n.id,
      depth: depthMap.get(n.id) ?? 99,
      isFirstIntent: n.id === firstIntentNodeId,
      isSearchHit: searchHitIds.has(n.id),
      isMirror: Boolean((n.data as { isMirror?: boolean } | undefined)?.isMirror),
      isCollapsed: !expanded.has(n.id) && initialEdges.some((e) => e.source === n.id), // has children but collapsed
      type: n.type,
    }));

    const edgeLabelMap = new Map<string, string[]>();
    for (const e of edges) {
      const key = `${e.source}|${e.target}`;
      if (!edgeLabelMap.has(key)) edgeLabelMap.set(key, []);
      if (e.label) edgeLabelMap.get(key)!.push(e.label);
    }

    const linkData = edges.map((e) => {
      const key = `${e.source}|${e.target}`;
      const labels = edgeLabelMap.get(key) ?? [];
      const el = labels.join(', ');
      return {
        source: e.source,
        target: e.target,
        label: el,
        rawLabel: el,
        color: e.style?.stroke ?? (el ? inferEdgeColor(el) : DEFAULT_EDGE_COLOR),
        method: el ? inferEdgeColor(el) : 'hierarchy',
        isHierarchy: true, // all edges from KB are hierarchy edges
      };
    });

    return { nodes: nodeData, links: linkData };
  }, [initialNodes, initialEdges, visibleNodeIds, firstIntentNodeId, searchHitIds, expanded]);

  // ── Toggle expand/collapse on node click ──────────────────────────────────
  const handleNodeClick = useCallback(
    (node: NodeObject) => {
      const id = node.id as string;
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          // Collapse — also recursively collapse descendants
          const childrenOf = new Map<string, string[]>();
          for (const e of initialEdges) {
            if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
            childrenOf.get(e.source)!.push(e.target);
          }
          const toRemove = [id];
          while (toRemove.length > 0) {
            const cid = toRemove.pop()!;
            next.delete(cid);
            const children = childrenOf.get(cid) ?? [];
            for (const c of children) {
              if (next.has(c)) toRemove.push(c);
            }
          }
        } else {
          next.add(id);
        }
        return next;
      });
      setHighlightNodeId(null);
    },
    [initialEdges],
  );

  const handleBackgroundClick = useCallback(() => {
    setHighlightNodeId(null);
  }, []);

  // ── Auto-expand first level on new data ───────────────────────────────────
  useEffect(() => {
    if (initialNodes.length > 0 && expanded.size === 0) {
      const newExpanded = new Set<string>();
      const hasInbound = new Set(initialEdges.map((e) => e.target));
      const roots = initialNodes
        .filter((n) => !hasInbound.has(n.id) || n.data?.isFirstIntent)
        .map((n) => n.id);
      // Auto-expand root + first level
      const childrenOf = new Map<string, string[]>();
      for (const e of initialEdges) {
        if (!childrenOf.has(e.source)) childrenOf.set(e.source, []);
        childrenOf.get(e.source)!.push(e.target);
      }
      for (const r of roots) {
        newExpanded.add(r);
        const children = childrenOf.get(r) ?? [];
        for (const c of children) {
          if (!hasInbound.has(c) || childrenOf.has(c)) newExpanded.add(c);
        }
      }
      setExpanded(newExpanded);
    }
  }, [initialNodes, initialEdges]);

  // ── Adjust d3 forces: charge + collide (depth-aware) ────────────────────
  useEffect(() => {
    if (fgRef.current && visibleGraph.nodes.length > 0) {
      // Charge adjusted for new depth distribution
      const charge = fgRef.current.d3Force('charge');
      if (charge) {
        charge.strength((node: any) => {
          const d = node.depth ?? 99;
          if (d <= 1) return -200;  // depth 2 has 67 nodes — push them out
          if (d <= 2) return -200;
          if (d <= 3) return -120;
          return -80;
        });
      }

      // Collide: depth 2 is densest (67 nodes), biggest spacing
      const collide = fgRef.current.d3Force('collide');
      if (collide) {
        collide.radius((node: any) => {
          const d = node.depth ?? 99;
          const baseR = (node.r || 6);
          if (d <= 0) return baseR * 2;
          if (d <= 1) return baseR * 3;
          if (d <= 2) return baseR * 3.5;  // 67 nodes → big spacing
          if (d <= 3) return baseR * 2.5;
          return baseR * 2;
        });
      }

      // Compute sub-cluster angular ranges from depth map
      const depthMap = new Map<string, number>();
      for (const n of visibleGraph.nodes as any[]) depthMap.set(n.id, n.depth);
      const clusterRanges = computeSubClusterRanges(initialNodes, initialEdges, depthMap);

      // Custom angular constraint force: push each node toward its group's angle
      let forceNodes: any[] = [];
      const angularForce = (alpha: number) => {
        const strength = 0.1 * alpha;
        for (const node of forceNodes) {
          const range = clusterRanges.get(node.id);
          if (!range) continue;
          const cx = node.x || 0;
          const cz = node.z || 0;
          if (cx === 0 && cz === 0) continue;
          const currentAngle = Math.atan2(cz, cx);
          let diff = range.angleCenter - currentAngle;
          while (diff > Math.PI) diff -= Math.PI * 2;
          while (diff < -Math.PI) diff += Math.PI * 2;
          // Rotate velocity vector toward target angle
          const moveAngle = diff * strength;
          const cos = Math.cos(moveAngle);
          const sin = Math.sin(moveAngle);
          node.vx = (node.vx || 0) + (cx * cos - cz * sin - cx) * 0.04;
          node.vz = (node.vz || 0) + (cx * sin + cz * cos - cz) * 0.04;
        }
      };
      angularForce.initialize = (nodes: any[]) => { forceNodes = nodes; };
      fgRef.current.d3Force('angular', angularForce as any);

      // Gentle center gravity
      const center = fgRef.current.d3Force('center');
      if (center) center.strength(0.03);
    }
  }, [visibleGraph.nodes.length]);

  // ── Re-zoom after visibility changes ──────────────────────────────────────
  useEffect(() => {
    if (fgRef.current && visibleGraph.nodes.length > 0) {
      const timer = setTimeout(() => {
        fgRef.current?.zoomToFit(600, 100);
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [visibleGraph.nodes.length, expanded]);

  // ── Fly to search result ──────────────────────────────────────────────────
  useEffect(() => {
    if (fgRef.current && currentSearchNode) {
      const node = visibleGraph.nodes.find((n) => n.id === currentSearchNode.id);
      if (node && (node as any).x !== undefined) {
        fgRef.current.cameraPosition(
          { x: ((node as any).x) * 1.5, y: ((node as any).y) * 1.5, z: ((node as any).z) * 1.5 + 200 },
          { x: (node as any).x, y: (node as any).y, z: (node as any).z },
          500,
        );
      }
    }
  }, [currentSearchNode, visibleGraph.nodes]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ForceGraph3D
        ref={fgRef}
        graphData={visibleGraph}
        backgroundColor="#0d1117"
        showNavInfo={false}
        // ── DAG radial layout ─────────────────────────────────────────────
        dagMode="radialout"
        dagLevelDistance={200}
        dagNodeFilter={(node: NodeObject) => {
          // Only layout visible nodes
          return visibleNodeIds.has(node.id as string);
        }}
        // ── Performance: skip force animation ─────────────────────────────
        warmupTicks={300}
        cooldownTicks={0}
        cooldownTime={0}
        nodeRelSize={7}
        // ── Hover-only tooltip (no permanent labels) ──────────────────────
        nodeLabel={(node: NodeObject) => {
          const n = node as any;
          const lines = n.label.split('\n');
          const displayName = lines[0] ?? n.id;
          const detail = lines.slice(1).join(' ') || '';
          const rootNote = rootIds.includes(n.id) ? '⏵ Root' : '';
          const collapseNote = n.isCollapsed ? '🔽 Click to expand' : '🔼 Click to collapse';
          return `
            <div style="font-family:sans-serif;padding:6px 10px;background:#1a1a2e;border:1px solid ${n.isFirstIntent ? '#f59e0b' : '#333'};border-radius:6px;color:#eee;max-width:260px">
              <b style="color:${n.isFirstIntent ? '#f59e0b' : '#61dafb'}">${displayName}</b>
              ${detail ? `<br/><span style="font-size:11px;color:#999">${detail}</span>` : ''}
              ${rootNote ? '<br/><span style="font-size:10px;color:#f59e0b">' + rootNote + '</span>' : ''}
              ${n.isMirror ? '<br/><span style="font-size:10px;color:#94a3b8">↻ Mirror</span>' : ''}
              <br/><span style="font-size:10px;color:#888">ID: ${n.id}</span>
              <br/><span style="font-size:10px;color:#666">${collapseNote}</span>
            </div>
          `;
        }}
        // ── Node colour ──────────────────────────────────────────────────
        nodeColor={(node: NodeObject) => {
          const n = node as any;
          if (highlightNodeId && n.id !== highlightNodeId) return '#444';
          if (n.isFirstIntent) return '#f59e0b';
          if (n.isSearchHit)   return '#eab308';
          if (n.isMirror)      return '#94a3b8';
          if (n.isCollapsed)   return '#888';
          return '#61dafb';
        }}
        // ── Custom 3D sphere node (no permanent label) ────────────────────
        nodeThreeObject={(node: NodeObject) => {
          const n = node as any;
          const isDimmed = !!(highlightNodeId && n.id !== highlightNodeId);
          let colorHex: number;
          if (isDimmed)           colorHex = NODE_COLORS.dimmed;
          else if (n.isFirstIntent) colorHex = NODE_COLORS.entry;
          else if (n.isSearchHit)   colorHex = NODE_COLORS.search;
          else if (n.isMirror)      colorHex = NODE_COLORS.mirror;
          else if (n.isCollapsed)   colorHex = NODE_COLORS.collapsed;
          else                     colorHex = NODE_COLORS.default;

          let r = 5;
          if (n.isFirstIntent) r = 8;
          else if (n.isSearchHit) r = 7;
          else if (n.isMirror) r = 4;
          else if (n.isCollapsed) r = 4.5;

          return makeSphereNode(colorHex, r, n.isFirstIntent, n.isSearchHit, n.isMirror, isDimmed, n.isCollapsed);
        }}
        // ── Edge style ────────────────────────────────────────────────────
        linkColor={(link: LinkObject) => {
          const l = link as any;
          if (highlightNodeId) {
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            return (srcId === highlightNodeId || tgtId === highlightNodeId) ? l.color : '#1a1a2e';
          }
          return l.color;
        }}
        linkWidth={(link: LinkObject) => {
          const l = link as any;
          if (highlightNodeId) {
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            return (srcId === highlightNodeId || tgtId === highlightNodeId) ? 3 : 0.2;
          }
          // Redirect edges: thickest
          if (l.color === '#3b82f6') return 2.5;
          // Follow-up, noh, procArg: at least 2px for readability
          if (l.color === '#f59e0b' || l.color === '#f43f5e' || l.color === '#8b5cf6') return 2;
          // DTMF: 2
          if (l.color === '#10b981') return 2;
          return 2;
        }}
        linkOpacity={(link: LinkObject) => {
          const l = link as any;
          if (highlightNodeId) {
            const srcId = typeof l.source === 'object' ? l.source?.id : l.source;
            const tgtId = typeof l.target === 'object' ? l.target?.id : l.target;
            return (srcId === highlightNodeId || tgtId === highlightNodeId) ? 0.8 : 0.05;
          }
          if (l.isHierarchy === false) return 0.2; // future: similarity edges dim
          return 0.5;
        }}
        linkDirectionalArrowLength={14}
        linkDirectionalArrowRelPos={0.93}
        linkDirectionalParticles={0}
        // ── Interactions ──────────────────────────────────────────────────
        onNodeClick={handleNodeClick}
        onBackgroundClick={handleBackgroundClick}
        enableNodeDrag={false}
        enableNavigationControls={true}
      />
    </div>
  );
}
