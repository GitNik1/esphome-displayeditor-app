export function pointFromClient(clientX, clientY, rect, zoom) {
  return [(clientX - rect.left) / zoom, (clientY - rect.top) / zoom];
}

export function snapAngle(origin, point, step) {
  const dx = point[0] - origin[0];
  const dy = point[1] - origin[1];
  const distance = Math.hypot(dx, dy);
  if (distance < 1e-6) return point;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  return [origin[0] + Math.cos(angle) * distance, origin[1] + Math.sin(angle) * distance];
}

export function widgetBoxStyle(box) {
  return {
    left: `${box.left}px`,
    top: `${box.top}px`,
    width: `${Math.max(1, box.width)}px`,
    height: `${Math.max(1, box.height)}px`,
  };
}
