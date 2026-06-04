import { FlowNode, FlowEdge } from './parseKB';
import type { KBAction, KBActionPayload, KBIntent, KBJson } from './parseKB';

// ─── Adjacency representation ────────────────────────────────────────────────

/** Per-target entry inside the adjacency map. */
export interface AdjacencyEntry {
  /** All edge labels (e.g. "[1]", "noh") for this collapsed source→target edge. */
  labels: Set<string>;
  /** All redirect methods ("dtmf", "noh", "followUp", "redirect", "procArg") that produced this edge. */
  methods: Set<string>;
  /** Stable insertion order across all collapsed edges in the graph. */
  order: number;
}

/** source intentId → (target intentId → merged edge metadata). */
export type Adjacency = Map<string, Map<string, AdjacencyEntry>>;

// ─── Step 1: sort intents & actions ──────────────────────────────────────────

/**
 * Returns the intent and action lists from the KB, sorted into a stable
 * order so the graph is deterministic.
 */
export function sortKBEntities(kb: KBJson): { intents: KBIntent[]; actions: KBAction[] } {
  const intents = [...(kb.intents ?? [])].sort(compareIntent);
  const actions = [...(kb.actions ?? [])].sort(compareAction);
  return { intents, actions };
}

function compareIntent(a: KBIntent, b: KBIntent): number {
  return (
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    compareIntentId(a.intentId, b.intentId)
  );
}

function compareAction(a: KBAction, b: KBAction): number {
  return (
    compareIntentId(a.intentId, b.intentId) ||
    (a.sortOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
    compareIntentId(a.actionId, b.actionId)
  );
}

function compareIntentId(a?: string, b?: string): number {
  return (a ?? '').localeCompare(b ?? '');
}

// ─── Step 2: intent lookup map ───────────────────────────────────────────────

/** Builds an `intentId → KBIntent` lookup map. */
export function buildIntentMap(intents: KBIntent[]): Map<string, KBIntent> {
  const map = new Map<string, KBIntent>();
  for (const intent of intents) map.set(intent.intentId, intent);
  return map;
}

// ─── Step 3: collapse actions → adjacency + used-intent set ──────────────────

/**
 * Walks the sorted action list, expands each action's payload into one or
 * more (source → target) redirects, and merges duplicate edges by
 * accumulating their labels and methods. Self-loops and references to
 * unknown intents are silently dropped.
 */
export function buildAdjacency(
  actions: KBAction[],
  intentMap: Map<string, KBIntent>,
  getRedirects: (action: KBAction) => Array<{ targetId: string; label: string; method: string }>,
): { adjacency: Adjacency; usedIntentIds: Set<string> } {
  const adjacency: Adjacency = new Map();
  const usedIntentIds = new Set<string>();
  let edgeOrder = 0;

  for (const action of actions) {
    const sourceIntentId = action.intentId;
    if (!sourceIntentId || !intentMap.has(sourceIntentId)) continue;

    const redirects = getRedirects(action);
    for (const redirect of redirects) {
      if (!redirect.targetId) continue;
      if (redirect.targetId === sourceIntentId) continue;
      if (!intentMap.has(redirect.targetId)) continue;

      let outgoing = adjacency.get(sourceIntentId);
      if (!outgoing) {
        outgoing = new Map();
        adjacency.set(sourceIntentId, outgoing);
      }

      let entry = outgoing.get(redirect.targetId);
      if (!entry) {
        entry = { labels: new Set(), methods: new Set(), order: edgeOrder++ };
        outgoing.set(redirect.targetId, entry);
      }

      entry.labels.add(redirect.label);
      entry.methods.add(redirect.method);
      usedIntentIds.add(sourceIntentId);
      usedIntentIds.add(redirect.targetId);
    }
  }

  return { adjacency, usedIntentIds };
}

/**
 * Augments the `usedIntentIds` set with any root-level intents (those
 * with `parentId === 'ROOT'` or `null`) that have at least one outgoing
 * edge. Ensures entry-point nodes always make it into the graph.
 */
export function markRootIntentsAsUsed(
  intents: KBIntent[],
  adjacency: Adjacency,
  usedIntentIds: Set<string>,
): void {
  for (const intent of intents) {
    const isRoot = intent.parentId === 'ROOT' || intent.parentId == null;
    if (isRoot && adjacency.has(intent.intentId)) {
      usedIntentIds.add(intent.intentId);
    }
  }
}

// ─── Step 4: pick a color for an edge based on its merged methods ────────────

/**
 * Method → hex color. Priority order (top-down) when an edge has been
 * collapsed from multiple redirects: dtmf wins over noh wins over
 * followUp, etc. The fallback gray is used when an edge has no methods.
 */
export function pickEdgeColor(methods: Set<string>): string {
  if (methods.has('dtmf')) return '#10b981';       // green
  if (methods.has('noh')) return '#f43f5e';         // red
  if (methods.has('followUp')) return '#f59e0b';   // orange
  if (methods.has('redirect')) return '#3b82f6';   // blue
  if (methods.has('procArg')) return '#8b5cf6';    // purple
  return '#b1b1b7';                                // gray (default)
}

// ─── Step 5: build FlowNode / FlowEdge arrays ───────────────────────────────

/**
 * Builds FlowNodes for the supplied intents. The first intent (if any) is
 * flagged with a ▶ arrow prefix in its label and `isFirstIntent: true`
 * in its data.
 */
export function buildFlowNodes(
  sortedUsedIntents: KBIntent[],
  firstIntentId: string | null,
): FlowNode[] {
  return sortedUsedIntents.map((intent) => {
    const isFirst = intent.intentId === firstIntentId;
    const arrow = isFirst ? '▶ ' : '';
    return {
      id: intent.intentId,
      position: { x: 0, y: 0 },
      data: {
        label: `${arrow}${intent.intentId}\n${intent.intentName}`,
        rawData: intent,
        isFirstIntent: isFirst,
      },
      type: 'default',
    };
  });
}

/**
 * Builds FlowEdges from the adjacency map, sorted by insertion order.
 * Each edge merges all of its source action's labels into a
 * comma-joined string and gets a color from `pickEdgeColor`.
 */
export function buildFlowEdges(adjacency: Adjacency): FlowEdge[] {
  const edges: FlowEdge[] = [];

  for (const [source, targets] of adjacency) {
    const sortedTargets = [...targets.entries()].sort(
      (a, b) => a[1].order - b[1].order,
    );

    for (const [target, meta] of sortedTargets) {
      const strokeColor = pickEdgeColor(meta.methods);
      edges.push({
        id: `${source}-${target}`,
        source,
        target,
        type: 'straight',
        animated: false,
        label: [...meta.labels].join(', '),
        style: { stroke: strokeColor, strokeWidth: 2 },
        labelBgStyle: { fill: '#ffffff', color: '#fff', fillOpacity: 0.8 },
        labelStyle: { fill: strokeColor, fontWeight: 700 },
      });
    }
  }

  return edges;
}

// ─── First-intent selection ─────────────────────────────────────────────────

/**
 * Picks the "first intent" — the entry point of the flow. Preference
 * order:
 *   1. The root intent (parentId === 'ROOT' / null) with the lowest
 *      sortOrder, among intents in the graph.
 *   2. The intent with the lowest sortOrder overall.
 *   3. The first intent in the supplied list.
 */
export function pickFirstIntentId(sortedIntents: KBIntent[]): string | null {
  if (sortedIntents.length === 0) return null;

  const roots = sortedIntents.filter(
    (i) => i.parentId === 'ROOT' || i.parentId == null,
  );
  const pool = roots.length > 0 ? roots : sortedIntents;
  return pool[0].intentId;
}

// ─── Redirect extraction ─────────────────────────────────────────────────────

/** A single (targetId, label, method) tuple produced from one action payload. */
export interface RedirectSource {
  targetId: string;
  label: string;
  method: string;
}

/** dtmfType=END_WITH_HASH → one edge using `payload.dtmfIntentId`. */
function collectEndWithHashRedirect(
  payload: KBActionPayload,
): RedirectSource[] {
  if (payload.dtmfType === 'END_WITH_HASH' && payload.dtmfIntentId) {
    return [
      { targetId: payload.dtmfIntentId, label: '[# entered]', method: 'dtmf' },
    ];
  }
  return [];
}

/** dtmfType=SINGLE_DIGIT → one edge per `dtmfOptions` entry. */
function collectSingleDigitRedirects(
  payload: KBActionPayload,
): RedirectSource[] {
  if (!Array.isArray(payload.dtmfOptions)) return [];
  const out: RedirectSource[] = [];
  for (const opt of payload.dtmfOptions) {
    if (!opt?.dtmfIntent) continue;
    out.push({
      targetId: opt.dtmfIntent,
      label: opt.dtmfPattern ? `[${opt.dtmfPattern}]` : '[digit]',
      method: 'dtmf',
    });
  }
  return out;
}

/** `payload.nohIntent` → one edge. */
function collectNohRedirect(payload: KBActionPayload): RedirectSource[] {
  return payload.nohIntent
    ? [{ targetId: payload.nohIntent, label: 'noh', method: 'noh' }]
    : [];
}

/** `payload.followUpIntent` → one edge. */
function collectFollowUpRedirect(payload: KBActionPayload): RedirectSource[] {
  return payload.followUpIntent
    ? [
        {
          targetId: payload.followUpIntent,
          label: 'followUp',
          method: 'followUp',
        },
      ]
    : [];
}

/** `payload.redirectIntent` → one edge. */
function collectRedirectIntent(payload: KBActionPayload): RedirectSource[] {
  return payload.redirectIntent
    ? [
        {
          targetId: payload.redirectIntent,
          label: 'redirect',
          method: 'redirect',
        },
      ]
    : [];
}

/** `payload.args` (procedure) → 0..N edges parsed from the args string. */
function collectProcArgRedirects(
  payload: KBActionPayload,
  intentMap: Map<string, KBIntent>,
): RedirectSource[] {
  if (!payload.args || typeof payload.args !== 'string') return [];
  return parseProcedureArgs(payload.args)
    .filter((a) => a.intentId && intentMap.has(a.intentId))
    .map((a) => ({ targetId: a.intentId, label: a.label, method: 'procArg' }));
}

/** Deduplicate redirects that share the same (targetId, label) pair. */
function dedupeRedirects(redirects: RedirectSource[]): RedirectSource[] {
  const seen = new Set<string>();
  return redirects.filter((r) => {
    const key = `${r.targetId}|${r.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract every redirect target from a single action payload. Pulls
 * from 6 sources (END_WITH_HASH dtmf, SINGLE_DIGIT dtmf options,
 * nohIntent, followUpIntent, redirectIntent, procedure args) and
 * dedupes by (targetId, label).
 */
export function getActionRedirects(
  payload: KBActionPayload,
  intentMap: Map<string, KBIntent>,
): RedirectSource[] {
  return dedupeRedirects([
    ...collectEndWithHashRedirect(payload),
    ...collectSingleDigitRedirects(payload),
    ...collectNohRedirect(payload),
    ...collectFollowUpRedirect(payload),
    ...collectRedirectIntent(payload),
    ...collectProcArgRedirects(payload, intentMap),
  ]);
}

/**
 * Parse a procedure args string for `<key>IntentId: "value"` patterns
 * and turn the key into a human-readable label
 * (e.g. `successIntentId` → `success`).
 */
function parseProcedureArgs(
  argsStr: string,
): Array<{ intentId: string; label: string }> {
  const results: Array<{ intentId: string; label: string }> = [];
  const regex = /(\w+IntentId):\s*["']([\w]+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(argsStr)) !== null) {
    const key = match[1];
    const intentId = match[2];
    let label = key.replace(/([A-Z])/g, ' $1').trim();
    label = label.replace(/ Intent Id$/, '').trim();
    results.push({ intentId, label });
  }
  return results;
}
