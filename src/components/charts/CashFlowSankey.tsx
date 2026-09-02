import { ResponsiveContainer, Sankey, Tooltip } from "recharts";
import { currency, currencyCompact } from "../../lib/format";
import type { Composition, CompositionNode } from "./cashFlowSankeyData";

// The per-year composition as a Sankey: sources on the left, the household
// in the middle, uses on the right, every band proportional to its dollars.
// Recharts lays it out; the node and link renderers below are custom so the
// diagram is labelled and carries the app's palette, which the defaults do
// neither of. Node order is the data layer's (`sort={false}`), so the
// diagram reads in the order the engine's steps run.

const NODE_WIDTH = 12;
const NODE_PADDING = 14;
const LABEL_GAP = 8;
// Room for a label and its amount beside each outer column.
const SIDE_MARGIN = 225;
const ROW_HEIGHT = 30;

function SankeyNodeShape(props: {
  x: number;
  y: number;
  width: number;
  height: number;
  index: number;
  nodes: CompositionNode[];
}) {
  const node = props.nodes[props.index];
  if (!node) return null;
  const { x, y, width, height } = props;
  const isHub = node.side === "hub";
  const isIn = node.side === "in";
  const amount = currencyCompact(node.value);
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={Math.max(height, 1)}
        fill={node.color}
        fillOpacity={0.9}
        rx={1}
      />
      {isHub ? (
        <text
          x={x + width / 2}
          y={y - 8}
          textAnchor="middle"
          fill="var(--text-primary)"
          fontSize={11.5}
          fontWeight={600}
        >
          {node.label}
          <tspan fill="var(--muted)" fontWeight={400}>
            {` ${amount}`}
          </tspan>
        </text>
      ) : (
        <text
          x={isIn ? x - LABEL_GAP : x + width + LABEL_GAP}
          y={y + height / 2}
          textAnchor={isIn ? "end" : "start"}
          dominantBaseline="middle"
          fill="var(--text-primary)"
          fontSize={11.5}
        >
          {isIn ? (
            <>
              <tspan fill="var(--muted)">{`${amount} `}</tspan>
              {node.label}
            </>
          ) : (
            <>
              {node.label}
              <tspan fill="var(--muted)">{` ${amount}`}</tspan>
            </>
          )}
        </text>
      )}
    </g>
  );
}

function SankeyLinkShape(props: {
  sourceX: number;
  targetX: number;
  sourceY: number;
  targetY: number;
  sourceControlX: number;
  targetControlX: number;
  linkWidth: number;
  index: number;
  composition: Composition;
}) {
  const link = props.composition.links[props.index];
  if (!link) return null;
  const source = props.composition.nodes[link.source];
  const target = props.composition.nodes[link.target];
  // A band takes the colour of whichever end is not the hub, so it reads as
  // "salary's share" or "the tax bill" rather than as plumbing.
  const color = source.side === "hub" ? target.color : source.color;
  const { sourceX, targetX, sourceY, targetY, sourceControlX, targetControlX } = props;
  return (
    <path
      d={`M${sourceX},${sourceY}C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(props.linkWidth, 1)}
      strokeOpacity={0.35}
    />
  );
}

function SankeyTooltip(props: {
  active?: boolean;
  payload?: { payload?: unknown; value?: number }[];
  composition: Composition;
}) {
  const entry = props.payload?.[0];
  if (!props.active || !entry) return null;
  const item = entry.payload as
    | { key?: string; fullLabel?: string; source?: unknown; target?: unknown }
    | undefined;
  const { nodes } = props.composition;
  let label: string;
  if (item && typeof item.source === "object" && typeof item.target === "object") {
    // A link: Recharts hands back the resolved endpoint nodes.
    const source = item.source as { key?: string };
    const target = item.target as { key?: string };
    const from = nodes.find((n) => n.key === source.key)?.fullLabel ?? "";
    const to = nodes.find((n) => n.key === target.key)?.fullLabel ?? "";
    label = `${from} → ${to}`;
  } else {
    label = item?.fullLabel ?? "";
  }
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-row">
        <span className="series-name">{label}</span>
        <strong>{currency(entry.value ?? 0)}</strong>
      </div>
    </div>
  );
}

export function CashFlowSankey(props: { composition: Composition }) {
  const { composition } = props;
  const inCount = composition.nodes.filter((n) => n.side === "in").length;
  const outCount = composition.nodes.filter((n) => n.side === "out").length;
  const height = Math.max(280, ROW_HEIGHT * Math.max(inCount, outCount) + 48);

  return (
    <ResponsiveContainer width="100%" height={height}>
      <Sankey
        data={{ nodes: composition.nodes, links: composition.links }}
        nameKey="fullLabel"
        sort={false}
        nodeWidth={NODE_WIDTH}
        nodePadding={NODE_PADDING}
        linkCurvature={0.5}
        margin={{ top: 28, right: SIDE_MARGIN, bottom: 8, left: SIDE_MARGIN }}
        node={(nodeProps) => <SankeyNodeShape {...nodeProps} nodes={composition.nodes} />}
        link={(linkProps) => <SankeyLinkShape {...linkProps} composition={composition} />}
      >
        <Tooltip content={<SankeyTooltip composition={composition} />} />
      </Sankey>
    </ResponsiveContainer>
  );
}
