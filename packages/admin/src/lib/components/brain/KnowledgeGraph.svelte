<script lang="ts">
  import { t } from "$lib/i18n";
  import type cytoscape from "cytoscape";

  import type { KnowledgeGraph, KnowledgeGraphNode } from "$lib/types/brain";

  interface Props {
    graph: KnowledgeGraph;
    onNodeSelect?: (node: KnowledgeGraphNode) => void;
    selectedNodeId?: string | null;
  }

  let { graph, onNodeSelect, selectedNodeId = null }: Props = $props();

  // $state and not a bare `let`: it is read inside the $effect below, and without
  // reactivity that effect does NOT re-run when `bind:this` assigns the
  // container. The graph was at the mercy of mount order.
  let container = $state<HTMLDivElement | null>(null);
  // A plain variable ON PURPOSE. As `$state` the effect below both read it (through
  // `initCytoscape`) and wrote it, so every init scheduled another: the graph was destroyed
  // while cytoscape was still laying it out ("Cannot read properties of null (reading
  // 'notify')", hundreds of times) and never painted. Nothing in the template reads it.
  let cyInstance: cytoscape.Core | null = null;
  let error = $state<string | null>(null);
  let initVersion = 0;

  const typeColors: Record<string, string> = {
    schema: "#b388ff",
    route: "#a855f7",
    kon: "#00e676",
    agent: "#ff2d6f",
    function: "#ffab00",
    dataset: "#3b82f6",
    general: "#9ca3af",
  };

  const legendItems = [
    { label: t("knowledgeGraph.schema"), color: typeColors.schema },
    { label: t("knowledgeGraph.route"), color: typeColors.route },
    { label: t("knowledgeGraph.kon"), color: typeColors.kon },
    { label: t("knowledgeGraph.agent"), color: typeColors.agent },
    { label: t("knowledgeGraph.function"), color: typeColors.function },
    { label: t("knowledgeGraph.dataset"), color: typeColors.dataset },
    { label: t("knowledgeGraph.general"), color: typeColors.general },
  ];

  function buildElements(graph: KnowledgeGraph) {
    const nodes = graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.label || node.id,
        type: node.type,
        group: node.group,
        importance: node.importance ?? 0.5,
        _node: node,
      },
    }));

    const edges = graph.edges.map((edge, index) => ({
      data: {
        id: `edge-${index}-${edge.source}-${edge.target}`,
        source: edge.source,
        target: edge.target,
        label: edge.relation,
        strength: edge.strength,
      },
    }));

    return { nodes, edges };
  }

  async function initCytoscape() {
    if (!container) return;

    const version = ++initVersion;

    if (cyInstance) {
      cyInstance.destroy();
      cyInstance = null;
    }

    try {
      const mod = await import("cytoscape");
      const cytoscape = (mod as any).default ?? mod;

      const { nodes, edges } = buildElements(graph);

      // If another init/cleanup started while we were awaiting the import, drop this one.
      if (version !== initVersion) {
        return;
      }

      const cy = cytoscape({
        container,
        elements: [...nodes, ...edges],
        style: [
          {
            selector: "node",
            style: {
              "background-color": "#9ca3af",
              label: t("knowledgeGraph.dataLabel"),
              color: "#e4e4e7",
              "font-size": "10px",
              "text-valign": "center",
              "text-halign": "center",
              "text-outline-color": "#18181b",
              "text-outline-width": 2,
              width: "mapData(importance, 0, 1, 24, 64)",
              height: "mapData(importance, 0, 1, 24, 64)",
              "transition-property": "background-color, border-width, border-color",
              "transition-duration": "150ms",
            },
          },
          ...Object.entries(typeColors).map(([type, color]) => ({
            selector: `node[type = '${type}'], node[group = '${type}']`,
            style: {
              "background-color": color,
            },
          })),
          {
            selector: "edge",
            style: {
              width: "mapData(strength, 0, 1, 1, 5)",
              "line-color": "#71717a",
              "target-arrow-color": "#71717a",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              label: t("knowledgeGraph.dataLabel"),
              "font-size": "9px",
              color: "#a1a1aa",
              "text-outline-color": "#18181b",
              "text-outline-width": 2,
              opacity: "mapData(strength, 0, 1, 0.25, 1)",
            },
          },
          {
            selector: ":selected",
            style: {
              "border-width": 3,
              "border-color": "#a855f7",
              "border-opacity": 1,
              "background-color": "#a855f7",
            },
          },
        ],
        layout: {
          name: "cose",
          padding: 20,
          animate: true,
          componentSpacing: 80,
          nodeRepulsion: 400000,
        } as any,
        minZoom: 0.2,
        maxZoom: 3,
        wheelSensitivity: 0.3,
      });

      cyInstance = cy;

      cy.on("tap", "node", (evt: cytoscape.EventObject) => {
        const data = evt.target.data("_node") as KnowledgeGraphNode;
        if (data) {
          onNodeSelect?.(data);
        }
      });

      error = null;
      applySelection();
    } catch (e) {
      console.error("[KnowledgeGraph] Failed to initialize Cytoscape", e);
      error = e instanceof Error ? e.message : t("knowledgeGraph.failedToRenderGraph");
      if (cyInstance) {
        cyInstance.destroy();
        cyInstance = null;
      }
    }
  }

  function applySelection() {
    if (!cyInstance) return;
    cyInstance.elements().unselect();
    if (selectedNodeId) {
      const node = cyInstance.getElementById(selectedNodeId);
      if (node.length > 0) {
        node.select();
        cyInstance.animate({ fit: { eles: node, padding: 80 } }, { duration: 250 });
      }
    }
  }

  $effect(() => {
    if (container && graph) {
      initCytoscape();
    }
    return () => {
      initVersion++;
      if (cyInstance) {
        cyInstance.destroy();
        cyInstance = null;
      }
    };
  });

  $effect(() => {
    selectedNodeId;
    applySelection();
  });
</script>

<div
  class="relative w-full h-full min-h-[400px] rounded-xl border border-kitsuden-border bg-kitsuden-bg overflow-hidden"
>
  {#if graph.nodes.length === 0}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center text-kitsuden-text-dim p-6"
    >
      <p class="text-sm">{t("knowledgeGraph.noKnowledgeNodesAvailable")}</p>
      <p class="text-xs text-kitsuden-subtle mt-1">{t("knowledgeGraph.runAScanToPopulate")}</p>
    </div>
  {:else if error}
    <div
      class="absolute inset-0 flex flex-col items-center justify-center text-kitsuden-accent-2 p-6"
    >
      <p class="text-sm font-medium">{t("knowledgeGraph.graphRenderingFailed")}</p>
      <p class="text-xs text-kitsuden-text-dim mt-1 max-w-md text-center">{error}</p>
    </div>
  {:else}
    <div bind:this={container} class="w-full h-full"></div>

    <!-- Legend -->
    <div
      class="absolute bottom-3 left-3 max-w-[220px] rounded-lg border border-kitsuden-border bg-kitsuden-card/90 backdrop-blur-xs p-2.5 shadow-lg"
    >
      <p class="text-xs font-semibold uppercase tracking-wider text-kitsuden-subtle mb-2">
        {t("knowledgeGraph.categories")}
      </p>
      <div class="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {#each legendItems as item}
          <div class="flex items-center gap-1.5">
            <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background-color: {item.color}"
            ></span>
            <span class="text-xs text-kitsuden-text-dim truncate">{item.label}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</div>
