/** A revision cloud: scallops bulging outward along a clockwise rectangle. */
export function cloud(x: number, y: number, width: number, height: number, step: number): string {
  const across = Math.max(2, Math.round(width / step));
  const down = Math.max(2, Math.round(height / step));
  const dx = width / across;
  const dy = height / down;
  const radius = Math.max(dx, dy) * 0.62;
  const arc = (ex: number, ey: number) => `a${radius} ${radius} 0 0 1 ${ex} ${ey}`;
  const parts = [`M${x} ${y}`];
  for (let i = 0; i < across; i++) parts.push(arc(dx, 0));
  for (let i = 0; i < down; i++) parts.push(arc(0, dy));
  for (let i = 0; i < across; i++) parts.push(arc(-dx, 0));
  for (let i = 0; i < down; i++) parts.push(arc(0, -dy));
  return `${parts.join(" ")}Z`;
}
