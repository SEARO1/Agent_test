import React, { useState } from 'react';
import JsonUploader from './components/JsonUploader';
import Canvas from './components/Canvas';
import { parseKBToGraph, checkAllIntentsAdded, IntentCheckResult, FlowNode, FlowEdge } from './components/parseKB';
import { useSearch } from './useSearch';
import './App.css';

function App() {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [showUploader, setShowUploader] = useState(false);
  const [checkResult, setCheckResult] = useState<IntentCheckResult | null>(null);

  const search = useSearch(nodes);

  const handleJsonLoaded = (data: any) => {
    try {
      const { nodes: newNodes, edges: newEdges } = parseKBToGraph(data);
      setNodes(newNodes);
      setEdges(newEdges);
      const result = checkAllIntentsAdded(data, newNodes);
      setCheckResult(result);
      setShowUploader(false);
      search.resetSearch();
    } catch (error) {
      console.error(error);
      alert("Invalid JSON format");
    }
  };

  return (
    <div className="App">
      <div className="top-bar">
        <div className="app-header">
          <h1>Knowledge Base Visualizer</h1>
        </div>

        {checkResult && (
          <div className={`intent-check ${checkResult.allAdded ? 'all-added' : 'missing'}`}>
            {checkResult.allAdded ? (
              <span className="check-icon">✅</span>
            ) : (
              <span className="check-icon">⚠️</span>
            )}
            <span className="check-text">
              {checkResult.addedIntents}/{checkResult.totalIntents} intents added
              {!checkResult.allAdded && ` · ${checkResult.missingIntents.length} missing`}
            </span>
            {!checkResult.allAdded && (
              <span className="missing-ids" title={checkResult.missingIntents.join(', ')}>
                {checkResult.missingIntents.join(', ')}
              </span>
            )}
          </div>
        )}

        <button
          className="upload-toggle"
          onClick={() => setShowUploader(!showUploader)}
        >
          {showUploader ? '▼ Hide Loader' : '▲ Load JSON'}
        </button>

        {showUploader && (
          <div className="uploader-popup">
            <JsonUploader onJsonLoaded={handleJsonLoaded} />
          </div>
        )}

        <div className="search-container">
          <input
            type="text"
            className="search-input"
            placeholder="Search by intent name or ID..."
            value={search.searchQuery}
            onChange={(e) => search.setSearchQuery(e.target.value)}
            onKeyDown={search.handleKeyDown}
          />
          <button className="search-btn" onClick={search.handleSearch}>Search</button>
          {search.searchResults.length > 0 && (
            <div className="search-results-nav">
              <button className="nav-btn" onClick={() => search.navigateResults('prev')}>▲</button>
              <span className="result-counter">
                {search.currentResultIndex + 1} / {search.searchResults.length}
              </span>
              <button className="nav-btn" onClick={() => search.navigateResults('next')}>▼</button>
            </div>
          )}
          {search.searchQuery && (
            <button className="clear-btn" onClick={search.clearSearch}>✕</button>
          )}
        </div>
      </div>

      <div className="main-content">
        {nodes.length > 0 ? (
          <div className="canvas-container">
            <Canvas
              initialNodes={nodes}
              initialEdges={edges}
              searchResults={search.searchResults}
              currentResultIndex={search.currentResultIndex}
            />
          </div>
        ) : (
          <div className="empty-state">
            <div className="empty-state-icon">📂</div>
            <h3>No Knowledge Base Loaded</h3>
            <p>Click "Load JSON" above to upload a file</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
