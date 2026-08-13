import { flowBoundsDocument } from "./renderer.js";
import {
  ensureImageEntry,
  newAnimimgWidget,
  newImageWidget,
  removeBakedWidget,
  strokeBaseName,
  strokeRenderBounds,
  upsertBakedWidget,
} from "./baking-model.js";
import { collectProjectWidgets } from "../project/model.js";

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export async function bakeGlowStroke({
  project,
  stroke,
  renderFrame,
  uploadFrame,
  contentOrigin,
  messages = {},
}) {
  if ((stroke.points || []).length < 2) return null;
  const frameCount = clamp(Number(stroke.flow.bake_frame_count) || 6, 1, 60);
  const crop = stroke.flow.bake_crop;
  const document = { strokes: [stroke] };
  const staticRect = crop
    ? strokeRenderBounds(stroke, project.canvas)
    : { left: 0, top: 0, right: project.canvas.width, bottom: project.canvas.height };
  const baseName = strokeBaseName(stroke);
  const target = stroke.parent_id
    ? collectProjectWidgets(project).find((widget) => widget.id === stroke.parent_id) || null
    : null;
  const origin = target ? contentOrigin(project, target) : { x: 0, y: 0 };
  const place = (widget) => {
    widget.x = Math.round(widget.x - origin.x);
    widget.y = Math.round(widget.y - origin.y);
    return widget;
  };
  const widgetMessages = {
    reserved: messages.reserved,
    collision: messages.collision,
  };

  const staticBlob = await renderFrame(document, staticRect, {
    withLines: true,
    withFlow: false,
    phase: 0,
  });
  const staticPath = await uploadFrame(`${baseName}_static.png`, staticBlob);
  const staticImageId = `img_${baseName}_static`;
  ensureImageEntry(project, staticImageId, staticPath);
  upsertBakedWidget(
    project,
    baseName,
    place(newImageWidget(baseName, staticRect, staticImageId)),
    target,
    widgetMessages,
  );

  const bakeDirection = async (suffix, mirror) => {
    const directional = mirror
      ? { ...stroke, flow: { ...stroke.flow, reversed: !stroke.flow.reversed } }
      : stroke;
    const directionalDocument = { strokes: [directional] };
    const animationRect = crop
      ? flowBoundsDocument(directionalDocument) || staticRect
      : staticRect;
    const frameIds = [];
    for (let index = 0; index < frameCount; index += 1) {
      const blob = await renderFrame(directionalDocument, animationRect, {
        withLines: false,
        withFlow: true,
        phase: index / frameCount,
      });
      const frameSuffix = String(index).padStart(2, "0");
      const path = await uploadFrame(`${baseName}_flow${suffix}_${frameSuffix}.png`, blob);
      const frameId = `img_${baseName}_flow${suffix}_${frameSuffix}`;
      ensureImageEntry(project, frameId, path);
      frameIds.push(frameId);
    }
    const widgetId = `${baseName}_anim${suffix}`;
    upsertBakedWidget(
      project,
      widgetId,
      place(newAnimimgWidget(widgetId, animationRect, frameIds, frameCount * 300)),
      target,
      widgetMessages,
    );
    return widgetId;
  };

  let forwardId = null;
  let reverseId = null;
  if (stroke.flow.enabled) {
    forwardId = await bakeDirection("", false);
    if (stroke.flow.bidirectional) reverseId = await bakeDirection("_rev", true);
    else removeBakedWidget(project, `${baseName}_anim_rev`, target);
  } else {
    removeBakedWidget(project, `${baseName}_anim`, target);
    removeBakedWidget(project, `${baseName}_anim_rev`, target);
  }
  return { baseName, forwardId, reverseId };
}

