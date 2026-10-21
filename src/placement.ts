/**
 * Surface placement for a foreman subagent: a split of the caller's pane to
 * the right (side by side) or down (stacked), or its own tmux window (tab).
 */
export type SurfacePlacement = "right" | "down" | "tab";

export const DEFAULT_SURFACE_PLACEMENT: SurfacePlacement = "right";

/** Parse a placement value; anything else is undefined. */
export function parseSurfacePlacement(
  value: unknown,
): SurfacePlacement | undefined {
  return value === "right" || value === "down" || value === "tab"
    ? value
    : undefined;
}
