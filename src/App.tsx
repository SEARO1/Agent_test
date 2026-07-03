import React, { useState, useCallback, useMemo } from 'react';
import JsonUploader from './components/JsonUploader';
import ForceGraph3DView from './components/ForceGraph3DView';
import LegendPanel from './components/LegendPanel';
import { parseKBToGraph, checkAllIntentsAdded, IntentCheckResult, FlowNode, FlowEdge } from './components/parseKB';
import './App.css';

function App() {
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [edges, setEdges] = useState<FlowEdge[]>([]);
  const [showUploader, setShowUploader] = useState(false);
  const [rawJson, setRawJson] = useState<any>(null);
  const [checkResult, setCheckResult] = useState<IntentCheckResult | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FlowNode[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(0);

  const handleJsonLoaded = (data: any) => {
    try {
      const { nodes: newNodes, edges: newEdges } = parseKBToGraph(data);
      setNodes(newNodes);
      setEdges(newEdges);
      setRawJson(data);
      const result = checkAllIntentsAdded(data, newNodes);
      setCheckResult(result);
      setShowUploader(false);
      setSearchQuery('');
      setSearchResults([]);
    } catch (error) {
      console.error(error);
      alert("Invalid JSON format");
    }
  };

  const handleSearch = useCallback(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      return;
    }

    const query = searchQuery.toLowerCase();
    const results = nodes.filter((node) => {
      const label = node.data.label?.toLowerCase() || '';
      const id = node.id?.toLowerCase() || '';
      return id.includes(query) || label.includes(query);
    });

    setSearchResults(results);
    setCurrentResultIndex(0);
  }, [searchQuery, nodes]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    } else if (e.key === 'F3' || (e.key === 'f' && e.ctrlKey)) {
      e.preventDefault();
      navigateResults('next');
    }
  };

  const navigateResults = (direction: 'next' | 'prev') => {
    if (searchResults.length === 0) return;

    if (direction === 'next') {
      setCurrentResultIndex((prev) =>
        prev < searchResults.length - 1 ? prev + 1 : 0
      );
    } else {
      setCurrentResultIndex((prev) =>
        prev > 0 ? prev - 1 : searchResults.length - 1
      );
    }
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIndex(0);
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
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <button className="search-btn" onClick={handleSearch}>Search</button>
          {searchResults.length > 0 && (
            <div className="search-results-nav">
              <button className="nav-btn" onClick={() => navigateResults('prev')}>▲</button>
              <span className="result-counter">
                {currentResultIndex + 1} / {searchResults.length}
              </span>
              <button className="nav-btn" onClick={() => navigateResults('next')}>▼</button>
            </div>
          )}
          {searchQuery && (
            <button className="clear-btn" onClick={clearSearch}>✕</button>
          )}
        </div>
      </div>

      <div className="main-content">
        {nodes.length > 0 ? (
          <div className="canvas-container">
            <ForceGraph3DView
              initialNodes={nodes}
              initialEdges={edges}
              searchResults={searchResults}
              currentResultIndex={currentResultIndex}
            />
            <LegendPanel />
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