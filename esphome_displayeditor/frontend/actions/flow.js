export function buildFlowAction({
  forwardId,
  reverseId = "",
  offThreshold,
  fastThreshold,
  normalDuration,
  fastDuration,
}) {
  const off = Math.max(0, Number(offThreshold) || 0);
  const fast = Number(fastThreshold) || 0;
  const normal = Math.max(10, Number(normalDuration) || 0);
  const fastMs = Math.max(10, Number(fastDuration) || 0);
  if (!forwardId) throw new Error("missing_forward_target");
  if (fast <= off) throw new Error("invalid_thresholds");

  const speedBranch = (id) => [
    { "lvgl.animimg.start": id },
    {
      if: {
        condition: { lambda: `return abs((int)x) >= ${fast};` },
        then: [{ "lvgl.animimg.update": { id, duration: `${fastMs}ms` } }],
        else: [{ "lvgl.animimg.update": { id, duration: `${normal}ms` } }],
      },
    },
  ];
  if (!reverseId) {
    return {
      if: {
        condition: { lambda: `return abs((int)x) <= ${off};` },
        then: [{ "lvgl.widget.hide": forwardId }],
        else: [{ "lvgl.widget.show": forwardId }, ...speedBranch(forwardId)],
      },
    };
  }
  return {
    if: {
      condition: { lambda: `return abs((int)x) <= ${off};` },
      then: [{ "lvgl.widget.hide": forwardId }, { "lvgl.widget.hide": reverseId }],
      else: [
        {
          if: {
            condition: { lambda: "return x > 0;" },
            then: [
              { "lvgl.widget.hide": reverseId },
              { "lvgl.widget.show": forwardId },
              ...speedBranch(forwardId),
            ],
            else: [
              { "lvgl.widget.hide": forwardId },
              { "lvgl.widget.show": reverseId },
              ...speedBranch(reverseId),
            ],
          },
        },
      ],
    },
  };
}

