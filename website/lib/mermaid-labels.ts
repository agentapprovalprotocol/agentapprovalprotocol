type Point = { x: number; y: number };
type Box = { x: number; y: number; width: number; height: number };

function intersects(a: Box, b: Box) {
  return a.x <= b.x + b.width && a.x + a.width >= b.x &&
    a.y <= b.y + b.height && a.y + a.height >= b.y;
}

// Work in SVG coordinates so the same clearance survives responsive scaling.
export function positionFlowchartLabels(svg: SVGSVGElement) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return;
  const inverse = matrix.inverse();
  const bounds = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    const start = new DOMPoint(rect.left, rect.top).matrixTransform(inverse);
    const end = new DOMPoint(rect.right, rect.bottom).matrixTransform(inverse);
    return { x: start.x, y: start.y, width: end.x - start.x, height: end.y - start.y };
  };
  const labels = [...svg.querySelectorAll<SVGGElement>(".edgeLabel > .label")];
  for (const label of labels) label.style.removeProperty("translate");
  const labelBounds = labels.map(bounds);
  const obstacles = [...svg.querySelectorAll(".node, .cluster-label")].map(bounds);
  for (const cluster of svg.querySelectorAll(".cluster > rect")) {
    const box = bounds(cluster);
    obstacles.push(
      { ...box, height: 0 }, { ...box, y: box.y + box.height, height: 0 },
      { ...box, width: 0 }, { ...box, x: box.x + box.width, width: 0 },
    );
  }

  // Short segments follow curved arrows closely without treating a whole curve
  // as a solid rectangle. Include every arrow, not just the label's own edge.
  const arrows: Box[] = [];
  for (const path of svg.querySelectorAll<SVGPathElement>(".flowchart-link")) {
    const pathMatrix = path.getScreenCTM();
    if (!pathMatrix) continue;
    const transform = inverse.multiply(pathMatrix);
    const length = path.getTotalLength();
    const steps = Math.max(1, Math.ceil(length / 2));
    let previous = path.getPointAtLength(0).matrixTransform(transform);
    for (let step = 1; step <= steps; step++) {
      const point = path.getPointAtLength(length * step / steps).matrixTransform(transform);
      arrows.push({
        x: Math.min(previous.x, point.x), y: Math.min(previous.y, point.y),
        width: Math.abs(point.x - previous.x), height: Math.abs(point.y - previous.y),
      });
      previous = point;
    }
  }

  const gap = 8;
  labels.forEach((label, index) => {
    const original = labelBounds[index];
    const isFree = ({ x, y }: Point) => {
      const padded = {
        x: original.x + x - gap, y: original.y + y - gap,
        width: original.width + gap * 2, height: original.height + gap * 2,
      };
      return !arrows.some((arrow) => intersects(padded, arrow)) &&
        !obstacles.some((node) => intersects(padded, node)) &&
        !labelBounds.some((other, otherIndex) => otherIndex !== index && intersects(padded, other));
    };

    // Prefer the nearest clear position above or below horizontal arrows,
    // or beside vertical ones. Keep labels close to their associated edge.
    let offset: Point | undefined = isFree({ x: 0, y: 0 }) ? { x: 0, y: 0 } : undefined;
    for (let distance = 4; !offset && distance <= 120; distance += 4) {
      const candidates = [
        { x: 0, y: -distance }, { x: 0, y: distance },
        { x: distance, y: 0 }, { x: -distance, y: 0 },
      ];
      // Diagonal candidates can fit between curved, opposing arrows where a
      // strictly horizontal or vertical move would push a label too far away.
      for (let step = 1; step < 16; step++) {
        if (step % 4 === 0) continue;
        const angle = step * Math.PI / 8;
        candidates.push({ x: distance * Math.cos(angle), y: distance * Math.sin(angle) });
      }
      offset = candidates.find(isFree);
    }
    if (!offset) return;
    label.style.translate = `${offset.x}px ${offset.y}px`;
    labelBounds[index] = { ...original, x: original.x + offset.x, y: original.y + offset.y };
  });

  // Labels can move beyond Mermaid's original bounds, particularly the top
  // arrow in an LR diagram. Extend the viewBox so those labels cannot clip.
  const view = svg.viewBox.baseVal;
  const left = Math.min(view.x, ...labelBounds.map((box) => box.x - gap));
  const top = Math.min(view.y, ...labelBounds.map((box) => box.y - gap));
  const right = Math.max(view.x + view.width, ...labelBounds.map((box) => box.x + box.width + gap));
  const bottom = Math.max(view.y + view.height, ...labelBounds.map((box) => box.y + box.height + gap));
  svg.setAttribute("viewBox", `${left} ${top} ${right - left} ${bottom - top}`);
  svg.style.maxWidth = `${right - left}px`;
}
