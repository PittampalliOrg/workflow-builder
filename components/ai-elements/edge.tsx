import {
  BaseEdge,
  type EdgeProps,
  getBezierPath,
  getSimpleBezierPath,
  type InternalNode,
  type Node,
  Position,
  useInternalNode,
} from "@xyflow/react";
import type { EdgeValidationState } from "@/lib/workflow-validation/types";

const Temporary = ({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) => {
  const [edgePath] = getSimpleBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <BaseEdge
      className="stroke-1"
      id={id}
      path={edgePath}
      style={{
        stroke: selected
          ? "color-mix(in srgb, var(--primary) 85%, white 15%)"
          : "color-mix(in srgb, var(--primary) 55%, var(--muted-foreground) 45%)",
        strokeDasharray: "8, 6",
        strokeWidth: selected ? 2.8 : 2.2,
        strokeLinecap: "round",
        filter: "drop-shadow(0 0 4px color-mix(in srgb, var(--primary) 35%, transparent))",
      }}
    />
  );
};

const getHandleCoordsByPosition = (
  node: InternalNode<Node>,
  handlePosition: Position
) => {
  // Choose the handle type based on position - Left is for target, Right is for source
  const handleType = handlePosition === Position.Left ? "target" : "source";

  const handle = node.internals.handleBounds?.[handleType]?.find(
    (h) => h.position === handlePosition
  );

  if (!handle) {
    return [0, 0] as const;
  }

  let offsetX = handle.width / 2;
  let offsetY = handle.height / 2;

  // this is a tiny detail to make the markerEnd of an edge visible.
  // The handle position that gets calculated has the origin top-left, so depending which side we are using, we add a little offset
  // when the handlePosition is Position.Right for example, we need to add an offset as big as the handle itself in order to get the correct position
  switch (handlePosition) {
    case Position.Left:
      offsetX = 0;
      break;
    case Position.Right:
      offsetX = handle.width;
      break;
    case Position.Top:
      offsetY = 0;
      break;
    case Position.Bottom:
      offsetY = handle.height;
      break;
    default:
      throw new Error(`Invalid handle position: ${handlePosition}`);
  }

  const x = node.internals.positionAbsolute.x + handle.x + offsetX;
  const y = node.internals.positionAbsolute.y + handle.y + offsetY;

  return [x, y] as const;
};

const getEdgeParams = (
  source: InternalNode<Node>,
  target: InternalNode<Node>
) => {
  const sourcePos = Position.Right;
  const [sx, sy] = getHandleCoordsByPosition(source, sourcePos);
  const targetPos = Position.Left;
  const [tx, ty] = getHandleCoordsByPosition(target, targetPos);

  return {
    sx,
    sy,
    tx,
    ty,
    sourcePos,
    targetPos,
  };
};

function getEdgeColors(input: {
  selected: boolean;
  validationState: EdgeValidationState;
}) {
  const { selected, validationState } = input;
  if (validationState === "invalid") {
    return {
      edgeStroke: selected
        ? "color-mix(in srgb, #dc2626 86%, white 14%)"
        : "color-mix(in srgb, #dc2626 68%, var(--muted-foreground) 32%)",
      glowStroke: selected
        ? "color-mix(in srgb, #dc2626 80%, white 20%)"
        : "color-mix(in srgb, #dc2626 75%, transparent 25%)",
    };
  }

  if (validationState === "warning") {
    return {
      edgeStroke: selected
        ? "color-mix(in srgb, #d97706 88%, white 12%)"
        : "color-mix(in srgb, #d97706 70%, var(--muted-foreground) 30%)",
      glowStroke: selected
        ? "color-mix(in srgb, #d97706 78%, white 22%)"
        : "color-mix(in srgb, #d97706 70%, transparent 30%)",
    };
  }

  return {
    edgeStroke: selected
      ? "color-mix(in srgb, var(--primary) 88%, white 12%)"
      : "color-mix(in srgb, var(--primary) 62%, var(--muted-foreground) 38%)",
    glowStroke: selected
      ? "color-mix(in srgb, var(--primary) 80%, white 20%)"
      : "color-mix(in srgb, var(--primary) 70%, transparent 30%)",
  };
}

const Animated = ({ id, source, target, style, selected, data }: EdgeProps) => {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!(sourceNode && targetNode)) {
    return null;
  }

  const { sx, sy, tx, ty, sourcePos, targetPos } = getEdgeParams(
    sourceNode,
    targetNode
  );

  const [edgePath] = getBezierPath({
    sourceX: sx,
    sourceY: sy,
    sourcePosition: sourcePos,
    targetX: tx,
    targetY: ty,
    targetPosition: targetPos,
  });

  const validationState =
    (data as { validationState?: EdgeValidationState } | undefined)
      ?.validationState ?? "valid";
  const { edgeStroke, glowStroke } = getEdgeColors({
    selected: selected ?? false,
    validationState,
  });

  return (
    <>
      <BaseEdge
        id={`${id}-glow`}
        path={edgePath}
        style={{
          stroke: glowStroke,
          strokeWidth: selected ? 8 : 6,
          opacity: selected ? 0.38 : 0.24,
          filter:
            "drop-shadow(0 0 6px color-mix(in srgb, var(--primary) 40%, transparent))",
          pointerEvents: "none",
        }}
      />
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          ...style,
          stroke: edgeStroke,
          strokeWidth: selected ? 3.2 : 2.6,
          strokeDasharray: selected ? "10 6" : "8 6",
          animation: "dashdraw 0.7s linear infinite",
          strokeLinecap: "round",
          strokeLinejoin: "round",
        }}
      />
    </>
  );
};

export const Edge = {
  Temporary,
  Animated,
};
