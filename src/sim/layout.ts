/**
 * Stage geometry: where each node card sits and where messages travel.
 *
 * Nodes go around an ellipse (S1 at the top, clockwise) so every pair has a
 * clear straight line between them for messages. Radii grow with the node
 * count so fixed-size cards never overlap (see layout.test.ts).
 */
import type { NodeId } from '../engine';

export const CARD_W = 220;
export const CARD_H = 236;
const PAD = 28;
/** Gap between a card's edge and where a message line starts/ends. */
const EDGE_GAP = 6;
/** Perpendicular offset so A→B and B→A messages use separate lanes. */
export const LANE = 7;

export interface Point {
  x: number;
  y: number;
}

export interface StageLayout {
  width: number;
  height: number;
  /** centers[id - 1] is the center of node S(id). */
  centers: Point[];
}

function radii(n: number): [number, number] {
  if (n <= 1) return [0, 0];
  if (n === 2) return [270, 0];
  if (n === 3) return [290, 170];
  if (n <= 5) return [390, 240];
  return [440, 292];
}

export function stageLayout(n: number): StageLayout {
  const [rx, ry] = radii(n);
  const width = 2 * rx + CARD_W + 2 * PAD;
  const height = 2 * ry + CARD_H + 2 * PAD;
  // Two nodes sit side by side; otherwise S1 starts at the top.
  const start = n === 2 ? Math.PI : -Math.PI / 2;
  const centers = Array.from({ length: n }, (_, i) => {
    const angle = start + (2 * Math.PI * i) / n;
    return { x: width / 2 + rx * Math.cos(angle), y: height / 2 + ry * Math.sin(angle) };
  });
  return { width, height, centers };
}

/**
 * The path a message from `a` to `b` travels: from the edge of a's card to
 * the edge of b's card, shifted sideways by `lane` (the shift flips with
 * direction, so requests and replies don't sit on top of each other).
 */
export function messagePath(a: Point, b: Point, lane = LANE): { from: Point; to: Point } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  // Distance from a card's center to its border along the direction of travel.
  const hw = CARD_W / 2 + EDGE_GAP;
  const hh = CARD_H / 2 + EDGE_GAP;
  const toEdge = Math.min(ux === 0 ? Infinity : hw / Math.abs(ux), uy === 0 ? Infinity : hh / Math.abs(uy));
  const ox = -uy * lane;
  const oy = ux * lane;
  return {
    from: { x: a.x + ux * toEdge + ox, y: a.y + uy * toEdge + oy },
    to: { x: b.x - ux * toEdge + ox, y: b.y - uy * toEdge + oy },
  };
}

export const lerp = (p: Point, q: Point, t: number): Point => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });

/** Is the link between two nodes cut by the UI's two-way partition? */
export function isCut(sideB: readonly NodeId[], a: NodeId, b: NodeId): boolean {
  return sideB.length > 0 && sideB.includes(a) !== sideB.includes(b);
}
