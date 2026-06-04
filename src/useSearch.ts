import { useCallback, useState } from 'react';
import { FlowNode } from './components/parseKB';

// ─── Public hook surface ──────────────────────────────────────────────────────

export interface UseSearchResult {
  /** Current search query text. Bound to the search input. */
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Result nodes matching the most recent search. */
  searchResults: FlowNode[];
  /** Index of the currently-focused result (used to center the canvas). */
  currentResultIndex: number;
  /** Run the search against the current `nodes` list. */
  handleSearch: () => void;
  /** Move the focused result to next/prev (with wrap-around). */
  navigateResults: (direction: 'next' | 'prev') => void;
  /** Clear the query and result list. */
  clearSearch: () => void;
  /** Reset all search state — call when a new KB is loaded. */
  resetSearch: () => void;
  /** Keyboard handler for the search input (Enter / Ctrl+F / F3). */
  handleKeyDown: (e: React.KeyboardEvent) => void;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Encapsulates the search-box + result-navigation state for the
 * Knowledge Base Visualizer. Pure state + derived handlers — no UI.
 * The component still owns the `<input>` rendering.
 */
export function useSearch(nodes: FlowNode[]): UseSearchResult {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<FlowNode[]>([]);
  const [currentResultIndex, setCurrentResultIndex] = useState(0);

  const handleSearch = useCallback(() => {
    const trimmed = searchQuery.trim();
    if (!trimmed) {
      setSearchResults([]);
      return;
    }
    const query = trimmed.toLowerCase();
    const results = nodes.filter((node) => {
      const label = (node.data.label ?? '').toLowerCase();
      const id = (node.id ?? '').toLowerCase();
      return id.includes(query) || label.includes(query);
    });
    setSearchResults(results);
    setCurrentResultIndex(0);
  }, [searchQuery, nodes]);

  const navigateResults = useCallback(
    (direction: 'next' | 'prev') => {
      if (searchResults.length === 0) return;
      setCurrentResultIndex((prev) => {
        if (direction === 'next') {
          return prev < searchResults.length - 1 ? prev + 1 : 0;
        }
        return prev > 0 ? prev - 1 : searchResults.length - 1;
      });
    },
    [searchResults],
  );

  const clearSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIndex(0);
  }, []);

  const resetSearch = useCallback(() => {
    setSearchQuery('');
    setSearchResults([]);
    setCurrentResultIndex(0);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSearch();
      } else if (e.key === 'F3' || (e.key === 'f' && e.ctrlKey)) {
        e.preventDefault();
        navigateResults('next');
      }
    },
    [handleSearch, navigateResults],
  );

  return {
    searchQuery,
    setSearchQuery,
    searchResults,
    currentResultIndex,
    handleSearch,
    navigateResults,
    clearSearch,
    resetSearch,
    handleKeyDown,
  };
}
