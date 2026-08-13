const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));

export function buildImportPayload(importState, width, height) {
  return {
    ...(importState.configuration
      ? { configuration: importState.configuration }
      : { content: importState.content }),
    canvas: {
      width: clamp(Number(width), 1, 4096),
      height: clamp(Number(height), 1, 4096),
    },
  };
}

export function summarizeImport(stats, translate) {
  const sourceLabels = {
    user: translate("canvas.source.user"),
    display_dimensions: translate("canvas.source.displayDimensions"),
    display_model: translate("canvas.source.displayModel"),
    root_grid: translate("canvas.source.rootGrid"),
    bounding_box: translate("canvas.source.boundingBox"),
    default: translate("canvas.source.default"),
  };
  const types = Object.entries(stats.widget_types)
    .map(([type, count]) => `${count}× ${type}`)
    .join(", ");
  const lines = [
    translate("import.summary.widgetsLine", { count: stats.widget_count, types }),
    translate("import.summary.canvasLine", {
      width: stats.canvas.width,
      height: stats.canvas.height,
      source: sourceLabels[stats.canvas.source] || stats.canvas.source,
    }),
  ];
  if (stats.images || stats.fonts || stats.styles) {
    lines.push(translate("import.summary.assetsLine", {
      images: stats.images,
      fonts: stats.fonts,
      styles: stats.styles,
    }));
  }
  const warnings = [];
  if (stats.unsupported_types.length) {
    warnings.push({
      text: translate("import.summary.unsupportedTypes", { types: stats.unsupported_types.join(", ") }),
      severe: false,
    });
  }
  if (stats.preserved_keys.length) {
    warnings.push({
      text: translate("import.summary.preservedKeys", { count: stats.preserved_keys.length }),
      severe: false,
    });
  }
  if (stats.issues.A) {
    warnings.push({
      text: translate("import.summary.blockingIssues", { count: stats.issues.A }),
      severe: true,
    });
  }
  return { lines, warnings };
}

