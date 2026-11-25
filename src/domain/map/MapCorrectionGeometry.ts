import type { CoordinateTransformer } from '../geometry/CoordinateTransformer';
import type { MapCorrection, MapPoint } from './MapCorrections';

// Cell units. Treat round-off near a geometric boundary as contact.
const epsilon = 1e-9;
const epsilonSquared = epsilon * epsilon;

interface Segment {
  from: MapPoint;
  to: MapPoint;
  dx: number;
  dy: number;
  lengthSquared: number;
}

type RasterShape =
  | { kind: 'capsules'; segments: readonly Segment[]; radius: number }
  | {
      kind: 'polygon';
      edges: readonly Segment[];
      minX: number;
      minY: number;
      maxX: number;
      maxY: number;
    };

type Coverage = 'centre' | 'intersection';

function segment(from: MapPoint, to: MapPoint): Segment {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return { from, to, dx, dy, lengthSquared: dx * dx + dy * dy };
}

function clampParameter(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function squaredDistanceToSegment(x: number, y: number, edge: Segment): number {
  const dx = x - edge.from.x;
  const dy = y - edge.from.y;
  const t =
    edge.lengthSquared === 0
      ? 0
      : clampParameter((dx * edge.dx + dy * edge.dy) / edge.lengthSquared);
  return (dx - t * edge.dx) ** 2 + (dy - t * edge.dy) ** 2;
}

function onSegment(point: MapPoint, edge: Segment): boolean {
  return squaredDistanceToSegment(point.x, point.y, edge) <= epsilonSquared;
}

function orientation(edge: Segment, point: MapPoint): number {
  const cross = edge.dx * (point.y - edge.from.y) - edge.dy * (point.x - edge.from.x);
  return Math.abs(cross) <= epsilon * Math.sqrt(edge.lengthSquared) ? 0 : Math.sign(cross);
}

function segmentsIntersect(a: Segment, b: Segment): boolean {
  const aStart = orientation(a, b.from);
  const aEnd = orientation(a, b.to);
  const bStart = orientation(b, a.from);
  const bEnd = orientation(b, a.to);
  return (
    (aStart * aEnd === -1 && bStart * bEnd === -1) ||
    (aStart === 0 && onSegment(b.from, a)) ||
    (aEnd === 0 && onSegment(b.to, a)) ||
    (bStart === 0 && onSegment(a.from, b)) ||
    (bEnd === 0 && onSegment(a.to, b))
  );
}

function polygonShape(vertices: readonly MapPoint[], rectangle: boolean): RasterShape {
  const edges = vertices.map((point, index) =>
    segment(point, vertices[(index + 1) % vertices.length]!),
  );
  const first = vertices[0]!;
  let twiceArea = 0;
  let minX = first.x,
    minY = first.y,
    maxX = first.x,
    maxY = first.y;
  for (let index = 0; index < edges.length; index += 1) {
    const edge = edges[index]!;
    const next = edges[(index + 1) % edges.length]!;
    if (
      edge.lengthSquared <= epsilonSquared ||
      onSegment(edge.from, next) ||
      onSegment(next.to, edge)
    ) {
      throw new Error('Polygon vertices must form distinct edges without backtracking.');
    }
    if (
      rectangle &&
      Math.abs(edge.dx * next.dx + edge.dy * next.dy) >
        epsilon * Math.sqrt(edge.lengthSquared * next.lengthSquared)
    ) {
      throw new Error('Rectangle vertices must form four right angles.');
    }
    for (let other = index + 2; other < edges.length; other += 1) {
      if (index === 0 && other === edges.length - 1) continue;
      if (segmentsIntersect(edge, edges[other]!))
        throw new Error('Polygon edges must not intersect.');
    }
    const { x, y } = edge.from;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    twiceArea += (x - first.x) * edge.dy - (y - first.y) * edge.dx;
  }
  if (Math.abs(twiceArea) <= epsilonSquared)
    throw new Error('Polygon must enclose a positive area.');
  return { kind: 'polygon', edges, minX, minY, maxX, maxY };
}

function checkedCellUnits(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new Error('Geometry exceeds the supported grid coordinate range.');
  }
  return value;
}

export function prepareCorrectionShape(
  correction: MapCorrection,
  transform: CoordinateTransformer,
  resolution: number,
): RasterShape {
  const gridPoint = ({ x, y }: MapPoint): MapPoint => {
    const { column, rowFromBottom } = transform.worldToGridPosition(x, y);
    return { x: checkedCellUnits(column), y: checkedCellUnits(rowFromBottom) };
  };
  const radiusInCells = (metres: number): number => {
    const radius = checkedCellUnits(metres / resolution);
    if (radius === 0) throw new Error('Geometry radius is too small for the grid resolution.');
    return radius;
  };
  if (correction.kind === 'wall') {
    const from = gridPoint(correction.from);
    const to = gridPoint(correction.to);
    if (from.x === to.x && from.y === to.y) throw new Error('Wall endpoints must be distinct.');
    return {
      kind: 'capsules',
      segments: [segment(from, to)],
      radius: radiusInCells(correction.thicknessM / 2),
    };
  }
  const area = correction.area;
  if (area.kind === 'polygon' || area.kind === 'rectangle') {
    return polygonShape(area.vertices.map(gridPoint), area.kind === 'rectangle');
  }
  const points = area.kind === 'circle' ? [gridPoint(area.center)] : area.points.map(gridPoint);
  const segments =
    points.length === 1
      ? [segment(points[0]!, points[0]!)]
      : points.slice(1).map((point, index) => segment(points[index]!, point));
  return { kind: 'capsules', segments, radius: radiusInCells(area.radiusM) };
}

function cellRange(min: number, max: number, size: number, coverage: Coverage): [number, number] {
  const inset = coverage === 'centre' ? 0.5 : 0;
  return [
    Math.max(0, Math.ceil(min - 1 + inset - epsilon)),
    Math.min(size - 1, Math.floor(max - inset + epsilon)),
  ];
}

function pointInPolygon(x: number, y: number, edges: readonly Segment[]): boolean {
  let inside = false;
  for (const edge of edges) {
    const { from, to } = edge;
    if (squaredDistanceToSegment(x, y, edge) <= epsilonSquared) return true;
    if (from.y > y !== to.y > y && x < from.x + ((y - from.y) * edge.dx) / edge.dy)
      inside = !inside;
  }
  return inside;
}

/** Segment intersection with a closed unit square, including edge and corner contact. */
function edgeIntersectsCell(edge: Segment, x: number, y: number): boolean {
  let enter = 0;
  let exit = 1;
  const { from, dx, dy } = edge;
  if (dx === 0) {
    if (from.x < x - epsilon || from.x > x + 1 + epsilon) return false;
  } else {
    const left = (x - epsilon - from.x) / dx;
    const right = (x + 1 + epsilon - from.x) / dx;
    enter = Math.max(enter, Math.min(left, right));
    exit = Math.min(exit, Math.max(left, right));
  }
  if (dy === 0) return enter <= exit && from.y >= y - epsilon && from.y <= y + 1 + epsilon;
  const bottom = (y - epsilon - from.y) / dy;
  const top = (y + 1 + epsilon - from.y) / dy;
  return Math.max(enter, Math.min(bottom, top)) <= Math.min(exit, Math.max(bottom, top));
}

function squaredDistanceToCell(point: MapPoint, x: number, y: number): number {
  return (
    Math.max(0, x - point.x, point.x - x - 1) ** 2 + Math.max(0, y - point.y, point.y - y - 1) ** 2
  );
}

function capsuleIntersectsCell(
  edge: Segment,
  radiusSquared: number,
  x: number,
  y: number,
): boolean {
  // A disjoint segment and square are closest at an endpoint or a square corner.
  return (
    squaredDistanceToCell(edge.from, x, y) <= radiusSquared ||
    squaredDistanceToCell(edge.to, x, y) <= radiusSquared ||
    edgeIntersectsCell(edge, x, y) ||
    squaredDistanceToSegment(x, y, edge) <= radiusSquared ||
    squaredDistanceToSegment(x + 1, y, edge) <= radiusSquared ||
    squaredDistanceToSegment(x, y + 1, edge) <= radiusSquared ||
    squaredDistanceToSegment(x + 1, y + 1, edge) <= radiusSquared
  );
}

function visitCapsule(
  edge: Segment,
  radius: number,
  width: number,
  height: number,
  coverage: Coverage,
  visit: (index: number) => void,
): void {
  const reach = radius + epsilon;
  const radiusSquared = reach * reach;
  const [bottom, top] = cellRange(
    Math.min(edge.from.y, edge.to.y) - reach,
    Math.max(edge.from.y, edge.to.y) + reach,
    height,
    coverage,
  );
  const inset = coverage === 'centre' ? 0.5 : 0;
  for (let y = bottom; y <= top; y += 1) {
    // Limit diagonal work to the part of the centreline within reach of this row.
    const start = edge.dy === 0 ? 0 : clampParameter((y + inset - reach - edge.from.y) / edge.dy);
    const end = edge.dy === 0 ? 1 : clampParameter((y + 1 - inset + reach - edge.from.y) / edge.dy);
    const a = edge.from.x + start * edge.dx;
    const b = edge.from.x + end * edge.dx;
    const [left, right] = cellRange(
      Math.min(a, b) - reach,
      Math.max(a, b) + reach,
      width,
      coverage,
    );
    const rowStart = (height - 1 - y) * width;
    for (let x = left; x <= right; x += 1) {
      const covered =
        coverage === 'centre'
          ? squaredDistanceToSegment(x + 0.5, y + 0.5, edge) <= radiusSquared
          : capsuleIntersectsCell(edge, radiusSquared, x, y);
      if (covered) visit(rowStart + x);
    }
  }
}

/** Both application and preview use this visitor. Adjacent capsules can visit the same cell. */
export function visitCorrectionCells(
  shape: RasterShape,
  coverage: Coverage,
  width: number,
  height: number,
  visit: (index: number) => void,
): void {
  if (shape.kind === 'capsules') {
    for (const edge of shape.segments)
      visitCapsule(edge, shape.radius, width, height, coverage, visit);
    return;
  }
  const { edges, minX, maxX, minY, maxY } = shape;
  const [left, right] = cellRange(minX, maxX, width, coverage);
  const [bottom, top] = cellRange(minY, maxY, height, coverage);
  for (let y = bottom; y <= top; y += 1) {
    const rowStart = (height - 1 - y) * width;
    for (let x = left; x <= right; x += 1) {
      if (
        pointInPolygon(x + 0.5, y + 0.5, edges) ||
        (coverage === 'intersection' && edges.some((edge) => edgeIntersectsCell(edge, x, y)))
      )
        visit(rowStart + x);
    }
  }
}
