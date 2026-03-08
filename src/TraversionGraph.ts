import { ConvertPathNode, type FileFormat, type FormatHandler } from "./FormatHandler.ts";
import { PriorityQueue } from './PriorityQueue.ts';

interface QueueNode {
    index: number;
    /** f = gcost + heuristic — used for priority queue ordering */
    cost: number;
    /** g = actual cost from start — used for path result and logging */
    gcost: number;
    /** Parent search node — null for the start node */
    parent: QueueNode | null;
    /** The handler+format edge that led to this node (null for the start node) */
    edge: ConvertPathNode | null;
    /** Depth of this node in the search tree (0 for start) — avoids walking parent chain to get length */
    depth: number;
    /** Position in visit order when this node was enqueued — used to allow re-visiting */
    visitedBorder: number;
};
interface CategoryChangeCost {
    from: string;
    to: string;
    handler?: string; // Optional handler name to specify that this cost only applies when using a specific handler for the category change. If not specified, the cost applies to all handlers for that category change.
    cost: number;
};

interface CategoryAdaptiveCost {
    categories: string[]; // List of sequential categories
    cost: number; // Cost to apply when a conversion involves all of the specified categories in sequence.
}


// Parameters for pathfinding algorithm.
const DEPTH_COST: number = 1; // Base cost for each conversion step. Higher values will make the algorithm prefer shorter paths more strongly.
const DEFAULT_CATEGORY_CHANGE_COST : number = 0.6; // Default cost for category changes not specified in CATEGORY_CHANGE_COSTS
const LOSSY_COST_MULTIPLIER : number = 1.4; // Cost multiplier for lossy conversions. Higher values will make the algorithm prefer lossless conversions more strongly.
const HANDLER_PRIORITY_COST : number = 0.02; // Cost multiplier for handler priority. Higher values will make the algorithm prefer handlers with higher priority more strongly.
const FORMAT_PRIORITY_COST : number = 0.05; // Cost multiplier for format priority. Higher values will make the algorithm prefer formats with higher priority more strongly.

const LOG_FREQUENCY = 5000;
/** Yield to the browser event loop every this many iterations to stay responsive */
const YIELD_EVERY = 4000;
/** Hard cap on search iterations — avoids infinite hang when no route exists. */
const MAX_SEARCH_ITERATIONS = 100_000;

export interface Node {
    identifier: string;
    edges: Array<number>;
};

export interface Edge {
    from: {format: FileFormat, index: number};
    to: {format: FileFormat, index: number};
    handler: string;
    cost: number;
};

export interface DeadRoute {
    handler: string;
    from: string;
    to: string;
}

export class TraversionGraph {
    private handlers: FormatHandler[] = [];
    private nodes: Node[] = [];
    private edges: Edge[] = [];
    /** Set to true by abortSearch() to cancel an in-progress searchPath call */
    private _searchAborted: boolean = false;
    // Keeps track of path segments that have failed when attempted during the last run
    private temporaryDeadEnds: ConvertPathNode[][] = [];

    /** Call this to cancel an in-progress searchPath (e.g. user clicked Cancel) */
    public abortSearch(): void {
        this._searchAborted = true;
    }
    private categoryChangeCosts: CategoryChangeCost[] = [
        {from: "image", to: "video", cost: 0.2}, // Almost lossless
        {from: "video", to: "image", cost: 0.4}, // Potentially lossy and more complex
        {from: "image", to: "audio", handler: "ffmpeg", cost: 100}, // FFMpeg can't convert images to audio
        {from: "audio", to: "image", handler: "ffmpeg", cost: 100}, // FFMpeg can't convert audio to images
        {from: "text", to: "audio", handler: "ffmpeg", cost: 100}, // FFMpeg can't convert text to audio
        {from: "audio", to: "text", handler: "ffmpeg", cost: 100}, // FFMpeg can't convert audio to text
        {from: "image", to: "audio", cost: 1.4}, // Extremely lossy
        {from: "audio", to: "image", cost: 1}, // Very lossy
        {from: "video", to: "audio", cost: 1.4}, // Might be lossy
        {from: "audio", to: "video", cost: 1}, // Might be lossy
        {from: "text", to: "image", cost: 0.5}, // Depends on the content and method, but can be relatively efficient for simple images
        {from: "image", to: "text", cost: 0.5}, // Depends on the content and method, but can be relatively efficient for simple images
        {from: "text", to: "audio", cost: 0.6}, // Somewhat lossy for anything that isn't speakable text
        {from: "document", to: "text", cost: 1}, // Often very lossy, loses rich formatting
    ];
    private categoryAdaptiveCosts: CategoryAdaptiveCost[] = [
        { categories: ["text", "image", "audio"], cost: 15 }, // Text to audio through an image is likely not what the user wants
        { categories: ["image", "video", "audio"], cost: 10000 }, // Converting from image to audio through video is especially lossy
        { categories: ["audio", "video", "image"], cost: 10000 }, // Converting from audio to image through video is especially lossy
    ];

    public addCategoryChangeCost(from: string, to: string, cost: number, handler?: string, updateIfExists: boolean = true) : boolean {
        if (this.hasCategoryChangeCost(from, to, handler)) {
            if (updateIfExists) {
                this.updateCategoryChangeCost(from, to, cost, handler)
                return true;
            }
            return false;
        }
        this.categoryChangeCosts.push({from, to, cost, handler: handler?.toLowerCase()});
        return true;
    }
    public removeCategoryChangeCost(from: string, to: string, handler?: string) : boolean {
        const initialLength = this.categoryChangeCosts.length;
        this.categoryChangeCosts = this.categoryChangeCosts.filter(c => !(c.from === from && c.to === to && c.handler === handler?.toLowerCase()));
        return this.categoryChangeCosts.length < initialLength;
    }
    public updateCategoryChangeCost(from: string, to: string, cost: number, handler?: string) {
        const costEntry = this.categoryChangeCosts.find(c => c.from === from && c.to === to && c.handler === handler?.toLowerCase());
        if (costEntry) costEntry.cost = cost;
        else this.addCategoryChangeCost(from, to, cost, handler);
    }
    public hasCategoryChangeCost(from: string, to: string, handler?: string) {
        return this.categoryChangeCosts.some(c => c.from === from && c.to === to && c.handler === handler?.toLowerCase());
    }


    public addCategoryAdaptiveCost(categories: string[], cost: number, updateIfExists: boolean = true) : boolean {
        if (this.hasCategoryAdaptiveCost(categories)) {
            if (updateIfExists) {
                this.updateCategoryAdaptiveCost(categories, cost);
                return true;
            }
            return false;
        }
        this.categoryAdaptiveCosts.push({categories, cost});
        return true;
    }
    public removeCategoryAdaptiveCost(categories: string[]) : boolean {
        const initialLength = this.categoryAdaptiveCosts.length;
        this.categoryAdaptiveCosts = this.categoryAdaptiveCosts.filter(c => !(c.categories.length === categories.length && c.categories.every((cat, index) => cat === categories[index])));
        return this.categoryAdaptiveCosts.length < initialLength;
    }
    public updateCategoryAdaptiveCost(categories: string[], cost: number) {
        const costEntry = this.categoryAdaptiveCosts.find(c => c.categories.length === categories.length && c.categories.every((cat, index) => cat === categories[index]));
        if (costEntry) costEntry.cost = cost;
        else this.addCategoryAdaptiveCost(categories, cost);
    }
    public hasCategoryAdaptiveCost(categories: string[]) {
        return this.categoryAdaptiveCosts.some(c => c.categories.length === categories.length && c.categories.every((cat, index) => cat === categories[index]));
    }

    public addDeadEndPath (pathFragment: ConvertPathNode[]) {
        this.temporaryDeadEnds.push(pathFragment);
    }
    public clearDeadEndPaths () {
        this.temporaryDeadEnds.length = 0;
    }

    /**
     * Initializes the traversion graph based on the supported formats and handlers. This should be called after all handlers have been registered and their supported formats have been cached in window.supportedFormatCache. The graph is built by creating nodes for each unique file format and edges for each possible conversion between formats based on the handlers' capabilities.
     * @param strictCategories If true, the algorithm will apply category change costs more strictly, even when formats share categories. This can lead to more accurate pathfinding at the cost of potentially longer paths and increased search time. If false, category change costs will only be applied when formats do not share any categories, allowing for more flexible pathfinding that may yield shorter paths but with less nuanced cost calculations.
     */
    /** Cached map of handler name → handler object for O(1) lookup */
    private handlerMap: Map<string, FormatHandler> = new Map();
    /** Cached map of handler-specific category change pairs */
    private handlerPairsCache: Map<string, string> | null = null;

    /**
     * Indexed category-change cost lookup.
     * Key: "fromCat->toCat", Value: array of {cost, handler?} entries.
     * Built once in init() to replace linear scans of categoryChangeCosts.
     */
    private categoryCostIndex: Map<string, Array<{cost: number, handler?: string}>> = new Map();

    private buildCategoryCostIndex(): void {
        this.categoryCostIndex.clear();
        for (const c of this.categoryChangeCosts) {
            const key = `${c.from}->${c.to}`;
            let arr = this.categoryCostIndex.get(key);
            if (!arr) { arr = []; this.categoryCostIndex.set(key, arr); }
            arr.push({ cost: c.cost, handler: c.handler });
        }
    }

    private getHandlerPairs(): Map<string, string> {
        if (!this.handlerPairsCache) {
            this.handlerPairsCache = new Map<string, string>(
                this.categoryChangeCosts.filter(c => c.handler)
                .map(c => [`${c.from}->${c.to}`, c.handler] as [string, string])
            );
        }
        return this.handlerPairsCache;
    }

    /** Map from node identifier to index for O(1) lookup */
    private nodeIndexMap: Map<string, number> = new Map();

    /**
     * Reconstructs the full path array from a QueueNode by walking parent pointers.
     * The start node's edge is the initial ConvertPathNode (e.g. the `from` node).
     */
    private static reconstructPath(node: QueueNode): ConvertPathNode[] {
        const path: ConvertPathNode[] = new Array(node.depth + 1);
        let current: QueueNode | null = node;
        let i = node.depth;
        while (current) {
            path[i--] = current.edge!;
            current = current.parent;
        }
        return path;
    }

    public init(supportedFormatCache: Map<string, FileFormat[]>, handlers: FormatHandler[], strictCategories: boolean = false, deadRoutes?: DeadRoute[]) {
        this.handlers = handlers;
        this.nodes.length = 0;
        this.edges.length = 0;
        this.handlerMap.clear();
        this.nodeIndexMap.clear();
        this.handlerPairsCache = null;
        for (const h of handlers) this.handlerMap.set(h.name, h);

        console.log("Initializing traversion graph...");
        const startTime = performance.now();
        let handlerIndex = 0;
        supportedFormatCache.forEach((formats, handler) => {
            let fromIndices: Array<{format: FileFormat, index: number}> = [];
            let toIndices: Array<{format: FileFormat, index: number}> = [];
            formats.forEach(format => {
                const formatIdentifier = format.mime + `(${format.format})`;
                let index = this.nodeIndexMap.get(formatIdentifier);
                if (index === undefined) {
                    index = this.nodes.length;
                    this.nodes.push({
                        identifier: formatIdentifier,
                        edges: []
                    });
                    this.nodeIndexMap.set(formatIdentifier, index);
                }
                if (format.from) fromIndices.push({format, index});
                if (format.to) toIndices.push({format, index});
            });
            fromIndices.forEach(from => {
                toIndices.forEach(to => {
                    if (from.index === to.index) return; // No self-loops
                    this.edges.push({
                        from: from,
                        to: to,
                        handler: handler,
                        cost: this.costFunction(
                            from,
                            to,
                            strictCategories,
                            handler,
                            handlerIndex
                        )
                    });
                    this.nodes[from.index].edges.push(this.edges.length - 1);
                });
            });
            handlerIndex++;
        });
        // Build the indexed category cost map for O(1) lookups in costFunction
        this.buildCategoryCostIndex();
        // Precompute minimum costs for a tighter A* heuristic
        if (this.edges.length > 0) {
            this.minEdgeCost = this.edges.reduce((min, e) => Math.min(min, e.cost), Infinity);
        }
        if (this.categoryChangeCosts.length > 0) {
            this.minCategoryChangeCost = this.categoryChangeCosts.reduce((min, c) => Math.min(min, c.cost), Infinity);
        }
        // Mark known-dead edges with Infinity cost so the pathfinder never selects them
        if (deadRoutes && deadRoutes.length > 0) {
            const deadSet = new Set(deadRoutes.map(r => `${r.handler}\0${r.from}\0${r.to}`));
            let pruned = 0;
            for (const e of this.edges) {
                const fromId = `${e.from.format.mime}(${e.from.format.format})`;
                const toId = `${e.to.format.mime}(${e.to.format.format})`;
                if (deadSet.has(`${e.handler}\0${fromId}\0${toId}`)) {
                    e.cost = Infinity;
                    pruned++;
                }
            }
            if (pruned > 0) console.log(`Pruned ${pruned} known-dead edges from ${deadRoutes.length} dead route entries.`);
        }
        const endTime = performance.now();
        console.log(`Traversion graph initialized in ${(endTime - startTime).toFixed(2)} ms with ${this.nodes.length} nodes and ${this.edges.length} edges.`);
    }
    /**
     * Cost function for calculating the cost of converting from one format to another using a specific handler.
     */
    private costFunction(
        from: { format: FileFormat; index: number; },
        to: { format: FileFormat; index: number; },
        strictCategories: boolean,
        handler: string,
        handlerIndex: number
    ) {
        let cost = DEPTH_COST; // Base cost for each conversion step

        const handlerPairs = this.getHandlerPairs();
        const handlerLower = handler.toLowerCase();
        // Calculate category change cost using indexed map
        const fromCategory = from.format.category || from.format.mime.split("/")[0];
        const toCategory = to.format.category || to.format.mime.split("/")[0];
        if (fromCategory && toCategory) {
            const fromCategories = Array.isArray(fromCategory) ? fromCategory : [fromCategory];
            const toCategories = Array.isArray(toCategory) ? toCategory : [toCategory];
            if (strictCategories) {
                // Strict mode: penalise each hop proportionally to the number
                // of category-change rules so the algorithm strongly prefers
                // shorter paths.  Matching rules substitute their specific cost
                // for the default, keeping category-aware weighting intact.
                let totalCost = this.categoryChangeCosts.length * DEFAULT_CATEGORY_CHANGE_COST;
                for (const fc of fromCategories) {
                    for (const tc of toCategories) {
                        const entries = this.categoryCostIndex.get(`${fc}->${tc}`);
                        if (!entries) continue;
                        for (const e of entries) {
                            if (!e.handler || e.handler === handlerLower) {
                                totalCost += e.cost - DEFAULT_CATEGORY_CHANGE_COST;
                                break;
                            }
                        }
                    }
                }
                cost += totalCost;
            }
            else if (!fromCategories.some(c => toCategories.includes(c))) {
                // Non-strict mode: find the minimum matching cost via indexed lookup
                let minCost = Infinity;
                for (const fc of fromCategories) {
                    for (const tc of toCategories) {
                        const entries = this.categoryCostIndex.get(`${fc}->${tc}`);
                        if (!entries) continue;
                        for (const e of entries) {
                            if ((!e.handler && handlerPairs.get(`${fc}->${tc}`) !== handlerLower)
                                || e.handler === handlerLower) {
                                if (e.cost < minCost) minCost = e.cost;
                            }
                        }
                    }
                }
                cost += minCost === Infinity ? DEFAULT_CATEGORY_CHANGE_COST : minCost;
            }
        }
        else if (fromCategory || toCategory) {
            // If one format has a category and the other doesn't, consider it a category change
            cost += DEFAULT_CATEGORY_CHANGE_COST;
        }

        // Add cost based on handler priority
        cost += HANDLER_PRIORITY_COST * handlerIndex;

        // Add cost based on format priority
        const handlerObj = this.handlerMap.get(handler);
        cost += FORMAT_PRIORITY_COST * (handlerObj?.supportedFormats?.findIndex(f => f.mime === to.format.mime) ?? 0);

        // Add cost multiplier for lossy conversions
        if (!to.format.lossless) cost *= LOSSY_COST_MULTIPLIER;

        return cost;
    }

    /**
     * Returns a copy of the graph data, including nodes, edges, category change costs, and category adaptive costs. This can be used for debugging, visualization, or analysis purposes. The returned data is a deep copy to prevent external modifications from affecting the internal state of the graph.
     */
    public getData() : {nodes: Node[], edges: Edge[], categoryChangeCosts: CategoryChangeCost[], categoryAdaptiveCosts: CategoryAdaptiveCost[]} {
        return {
            nodes: this.nodes.map(node => ({identifier: node.identifier, edges: [...node.edges]})),
            edges: this.edges.map(edge => ({
                from: {format: {...edge.from.format}, index: edge.from.index},
                to: {format: {...edge.to.format}, index: edge.to.index},
                handler: edge.handler,
                cost: edge.cost
            })),
            categoryChangeCosts: this.categoryChangeCosts.map(c => ({from: c.from, to: c.to, handler: c.handler, cost: c.cost})),
            categoryAdaptiveCosts: this.categoryAdaptiveCosts.map(c => ({categories: [...c.categories], cost: c.cost}))
        };
    }
    /**
     * @coverageIgnore
     */
    public print() {
        let output = "Nodes:\n";
        this.nodes.forEach((node, index) => {
            output += `${index}: ${node.identifier}\n`;
        });
        output += "Edges:\n";
        this.edges.forEach((edge, index) => {
            output += `${index}: ${edge.from.format.mime} -> ${edge.to.format.mime} (handler: ${edge.handler}, cost: ${edge.cost})\n`;
        });
        console.log(output);
    }

    private listeners: Array<(state: string, path: ConvertPathNode[]) => void> = [];
    public addPathEventListener(listener: (state: string, path: ConvertPathNode[]) => void) {
        this.listeners.push(listener);
    }
    public removePathEventListener(listener: (state: string, path: ConvertPathNode[]) => void) {
        const idx = this.listeners.indexOf(listener);
        if (idx >= 0) this.listeners.splice(idx, 1);
    }

    private dispatchEvent(state: string, path: ConvertPathNode[]) {
        this.listeners.forEach(l => l(state, path));
    }

    /** Precomputed minimum edge cost across the entire graph for tighter heuristic bounds */
    private minEdgeCost: number = DEPTH_COST;
    /** Precomputed minimum category-change cost for cross-category heuristic */
    private minCategoryChangeCost: number = DEFAULT_CATEGORY_CHANGE_COST;

    /**
     * A* heuristic: estimates minimum remaining cost from `current` to `target`.
     * Admissible: never overestimates (uses the minimum possible cost per step).
     * Uses precomputed minimum costs for tighter bounds, guiding A* to explore
     * fewer irrelevant nodes and find paths faster.
     */
    private heuristic(current: FileFormat, target: FileFormat): number {
        if (current.mime === target.mime && current.format === target.format) return 0;
        const currentCats = [current.category ?? current.mime.split("/")[0]].flat();
        const targetCats = [target.category ?? target.mime.split("/")[0]].flat();
        // Same category — at least one conversion step at minimum edge cost
        if (currentCats.some(c => targetCats.includes(c))) return this.minEdgeCost;
        // Different category — one step to bridge categories + the category change cost
        return this.minEdgeCost + this.minCategoryChangeCost;
    }

    public async* searchPath(from: ConvertPathNode, to: ConvertPathNode) : AsyncGenerator<ConvertPathNode[]> {
        // A* multi-path: uses heuristic for efficiency + visitedBorder for yielding multiple paths
        let queue: PriorityQueue<QueueNode> = new PriorityQueue<QueueNode>(
            1000,
            (a: QueueNode, b: QueueNode) => a.cost - b.cost
        );
        // Map from node index → position in visit order (allows re-visiting via visitedBorder)
        let visitedMap = new Map<number, number>();
        let visitedCount = 0;
        const fromIdentifier = from.format.mime + `(${from.format.format})`;
        const toIdentifier = to.format.mime + `(${to.format.format})`;
        let fromIndex = this.nodeIndexMap.get(fromIdentifier);
        let toIndex = this.nodeIndexMap.get(toIdentifier);
        if (fromIndex === undefined || toIndex === undefined) return []; // If either format is not in the graph, return empty array
        const toFormat = to.format;
        const h0 = this.heuristic(from.format, toFormat);
        queue.add({index: fromIndex, cost: h0, gcost: 0, parent: null, edge: from, depth: 0, visitedBorder: 0});
        console.log(`Starting path search from ${from.format.mime}(${from.handler?.name}) to ${to.format.mime}(${to.handler?.name})`);
        let iterations = 0;
        let pathsFound = 0;
        this._searchAborted = false; // reset from any previous call
        while (queue.size() > 0) {
            iterations++;

            // Keep the browser responsive: yield to the event loop every YIELD_EVERY steps
            if (iterations % YIELD_EVERY === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
            // Hard stop to prevent infinite hang when no route exists
            if (iterations > MAX_SEARCH_ITERATIONS) {
                console.warn(`searchPath exceeded ${MAX_SEARCH_ITERATIONS} iterations — aborting to prevent hang.`);
                return;
            }
            // User-requested abort (Cancel button)
            if (this._searchAborted) {
                console.log(`Path search aborted by user after ${iterations} iterations.`);
                return;
            }
            // Get the node with the lowest cost
            let current = queue.poll()!;

            // Skip nodes with Infinity cost (known dead-end descendants)
            if (!isFinite(current.cost)) continue;

            // --- Visited check: allow re-visiting if node was queued before it was first visited ---
            const visitPos = visitedMap.get(current.index);
            if (visitPos !== undefined && visitPos < current.visitedBorder) {
                this.dispatchEvent("skipped", TraversionGraph.reconstructPath(current));
                continue;
            }

            if (current.index === toIndex) {
                // Reconstruct the full path from parent pointers
                const path = TraversionGraph.reconstructPath(current);
                // Return the path of handlers and formats to get from the input format to the output format
                const logString = `${iterations} with cost ${current.gcost.toFixed(3)}: ${path.map(p => p.handler.name + "(" + p.format.mime + ")").join(" → ")}`;
                console.log(`Found path at iteration ${logString}`);
                this.dispatchEvent("found", path);
                yield path;
                pathsFound++;
                continue;
            }

            // Mark current node as visited
            visitedMap.set(current.index, visitedCount++);
            this.dispatchEvent("searching", TraversionGraph.reconstructPath(current));

            this.nodes[current.index].edges.forEach(edgeIndex => {
                let edge = this.edges[edgeIndex];

                // Multi-path: visited border check
                const visitPos = visitedMap.get(edge.to.index);
                if (visitPos !== undefined && visitPos < current.visitedBorder) return;

                const handler = this.handlerMap.get(edge.handler);
                if (!handler) return; // If the handler for this edge is not found, skip it

                const childEdge: ConvertPathNode = {handler: handler, format: edge.to.format};
                const childNode: QueueNode = {
                    index: edge.to.index,
                    cost: 0, // placeholder, set below
                    gcost: 0, // placeholder, set below
                    parent: current,
                    edge: childEdge,
                    depth: current.depth + 1,
                    visitedBorder: visitedCount
                };
                const adaptiveCost = this.calculateAdaptiveCostFromNode(childNode);
                const gcost = current.gcost + edge.cost + adaptiveCost;
                const hcost = this.heuristic(edge.to.format, toFormat);
                childNode.gcost = gcost;
                childNode.cost = gcost + hcost;
                queue.add(childNode);
            });
            if (iterations % LOG_FREQUENCY === 0) {
                console.log(`Still searching... Iterations: ${iterations}, Paths found: ${pathsFound}, Queue length: ${queue.size()}`);
                const statusEl = document.getElementById("convert-search-status");
                if (statusEl) statusEl.textContent = `Searching\u2026 (${iterations.toLocaleString()} steps explored)`;
            }
        }
        console.log(`Path search completed. Total iterations: ${iterations}, Total paths found: ${pathsFound}`);
    }

    private static pathNodesMatch(a: ConvertPathNode, b: ConvertPathNode): boolean {
        return a === b
            || (a.handler.name === b.handler.name
                && a.format.mime === b.format.mime
                && a.format.format === b.format.format);
    }

    /**
     * Calculates adaptive cost by walking the parent-pointer chain of a QueueNode.
     * Avoids allocating a full path array on every edge expansion.
     */
    private calculateAdaptiveCostFromNode(node: QueueNode): number {
        const pathLength = node.depth + 1;

        // --- Dead-end check: walk the parent chain and compare against each dead end ---
        for (const deadEnd of this.temporaryDeadEnds) {
            if (pathLength < deadEnd.length) continue; // path too short to match
            // We need to compare the FIRST deadEnd.length nodes of the path.
            // Collect them by walking back from node and taking the first deadEnd.length elements.
            // Since we walk back from the end, build a small temporary array of just the prefix we need.
            let isDeadEnd = true;
            // Walk back to the start to get path in order for the prefix check
            let current: QueueNode | null = node;
            // Collect the full path into a reusable array (only the edges/ConvertPathNodes)
            const pathNodes: ConvertPathNode[] = new Array(pathLength);
            let idx = pathLength - 1;
            while (current) {
                pathNodes[idx--] = current.edge!;
                current = current.parent;
            }
            for (let i = 0; i < deadEnd.length; i++) {
                if (TraversionGraph.pathNodesMatch(pathNodes[i], deadEnd[i])) continue;
                isDeadEnd = false;
                break;
            }
            if (isDeadEnd) return Infinity;
        }

        // --- Category adaptive cost: walk parent chain in reverse (already tail-first) ---
        // Build categories array in reverse order from parent chain for backward matching
        let cost = 0;
        if (this.categoryAdaptiveCosts.length > 0) {
            // Build categories in reverse (index 0 = last node in path, i.e. `node` itself)
            const reversedCats: (string | string[])[] = new Array(pathLength);
            let cur: QueueNode | null = node;
            let ri = 0;
            while (cur) {
                const edge = cur.edge!;
                const cat = edge.format.category || edge.format.mime.split("/")[0];
                reversedCats[ri++] = cat;
                cur = cur.parent;
            }

            this.categoryAdaptiveCosts.forEach(c => {
                // pathPtr walks from 0 (last path node) upward = backward through path
                // This mirrors the original: pathPtr starts at categoriesInPath.length - 1
                let pathPtr = 0, categoryPtr = c.categories.length - 1;
                while (true) {
                    const cats = reversedCats[pathPtr];
                    const includes = Array.isArray(cats)
                        ? cats.includes(c.categories[categoryPtr])
                        : cats === c.categories[categoryPtr];
                    if (includes) {
                        categoryPtr--;
                        pathPtr++;

                        if (categoryPtr < 0) {
                            cost += c.cost;
                            break;
                        }
                        if (pathPtr >= pathLength) break;
                    }
                    else {
                        const nextCat = c.categories[categoryPtr + 1];
                        if (categoryPtr + 1 < c.categories.length) {
                            const nextIncludes = Array.isArray(cats)
                                ? cats.includes(nextCat)
                                : cats === nextCat;
                            if (nextIncludes) {
                                pathPtr++;
                                if (pathPtr >= pathLength) break;
                                continue;
                            }
                        }
                        break;
                    }
                }
            });
        }
        return cost;
    }

}
