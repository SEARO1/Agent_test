import { useEffect, useCallback, useMemo, useState } from 'react';
import {
  ReactFlow,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  addEdge,
  Connection,
  Edge,
  Node,
  MiniMap,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { FlowNode, FlowEdge } from './parseKB';
import {
  decorateNode,
  decorateEdge,
  getMiniMapNodeColor,
  MiniMapColorContext,
} from './nodeStyling';
import { getLayoutedElements } from './elkLayout';

interface CanvasProps {
  initialNodes: FlowNode[];
  initialEdges: FlowEdge[];
  searchResults?: FlowNode[];
  currentResultIndex?: number;
}

function CanvasInner({ initialNodes, initialEdges, searchResults = [], currentResultIndex = 0 }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { setCenter, getNode } = useReactFlow();

  // Click-to-highlight selection (edge only).
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);

  const currentSearchNode = searchResults[currentResultIndex];

  useEffect(() => {
    const applyLayout = async () => {
      const { nodes: layoutedNodes, edges: layoutedEdges } = await getLayoutedElements(
        initialNodes,
        initialEdges,
        'TB'
      );

      setNodes(layoutedNodes as Node[]);
      setEdges(layoutedEdges as Edge[]);
    };

    applyLayout();
  }, [initialNodes, initialEdges, setNodes, setEdges]);

  // Center on the current search result node
  useEffect(() => {
    if (currentSearchNode) {
      const node = getNode(currentSearchNode.id);
      if (node) {
        setCenter(node.position.x + 125, node.position.y + 40, { duration: 500, zoom: 1.5 });
      }
    }
  }, [currentSearchNode, setCenter, getNode]);

  const highlightedNodeIds = useMemo(() => {
    return new Set(searchResults.map(n => n.id));
  }, [searchResults]);

  // The "first intent" (entry point of the flow) — the node that gets
  // the ▶ arrow marker. Used to apply the entry-point visual style and
  // to color it distinctly in the MiniMap.
  const firstIntentNodeId = useMemo(() => {
    return initialNodes.find(n => n.data?.isFirstIntent)?.id ?? null;
  }, [initialNodes]);

  // Compute the highlighted-node set for the current click selection
  // (edge-only: just the two endpoints of the selected edge).
  const clickHighlightedNodeIds = useMemo(() => {
    if (selectedEdgeId) {
      const edge = edges.find((e) => e.id === selectedEdgeId);
      if (edge) return new Set([edge.source, edge.target]);
      return new Set<string>();
    }
    return null; // null = no click selection active
  }, [selectedEdgeId, edges]);

  // Edges to keep visible/emphasized: the single selected edge.
  const clickHighlightedEdgeIds = useMemo(() => {
    if (selectedEdgeId) {
      return new Set([selectedEdgeId]);
    }
    return null;
  }, [selectedEdgeId]);

  // Toggle helper — clicking the same edge twice clears the selection.
  const handleEdgeClick = useCallback((_evt: React.MouseEvent, edge: Edge) => {
    setSelectedEdgeId((prev) => (prev === edge.id ? null : edge.id));
  }, []);

  const handlePaneClick = useCallback(() => {
    // Clicking on empty canvas clears the selection.
    setSelectedEdgeId(null);
  }, []);

  const handleNodeClick = useCallback(() => {
    return;
  }, []);

  // Whether click-highlight is currently active.
  const clickActive = clickHighlightedNodeIds !== null;

  const onConnect = useCallback(
    (params: Connection) => setEdges((eds: Edge[]) => addEdge(params, eds)),
    [setEdges],
  );

  const handleMiniMapClick = useCallback(
    (_event: React.MouseEvent, position: { x: number; y: number }) => {
      setCenter(position.x, position.y, { duration: 200 });
    },
    [setCenter],
  );

  const miniMapCtx: MiniMapColorContext = {
    firstIntentNodeId,
    currentSearchNodeId: currentSearchNode?.id ?? null,
    clickActive,
    clickHighlightedNodeIds: clickHighlightedNodeIds ?? new Set<string>(),
    highlightedNodeIds,
  };

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes.map((node) => decorateNode(node, {
            isSearchHit: highlightedNodeIds.has(node.id),
            isClickHighlighted: clickActive && (clickHighlightedNodeIds?.has(node.id) ?? false),
            isFirstIntent: node.id === firstIntentNodeId,
            isMirror: Boolean((node.data as { isMirror?: boolean } | undefined)?.isMirror),
            clickActive,
          }))}
        edges={edges.map((edge) => decorateEdge(edge, {
            clickActive,
            isClickHighlighted: clickHighlightedEdgeIds?.has(edge.id) ?? false,
          }))}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={handleEdgeClick}
        onNodeClick={handleNodeClick}
        onPaneClick={handlePaneClick}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        attributionPosition="bottom-right"
      >
        <Background gap={20} color="#e0e0e0" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          onClick={handleMiniMapClick}
          nodeColor={(node) => getMiniMapNodeColor(node, miniMapCtx)}
          nodeStrokeWidth={2}
          maskColor="rgba(0, 0, 0, 0.1)"
          style={{ background: '#f5f5f5' }}
        />
      </ReactFlow>
    </div>
  );
}

export default function Canvas(props: CanvasProps) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}