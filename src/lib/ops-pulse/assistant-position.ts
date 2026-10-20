export type AssistantPreference = { side: "left" | "right"; y: number; collapsed: boolean };
export type AssistantViewport = { width: number; height: number; left: number; top: number };
export type AssistantPoint = { x: number; y: number };

export const ASSISTANT_POSITION_KEY = "opspulse.assistant-position.v1";
export const DEFAULT_ASSISTANT_POSITION: AssistantPreference = { side: "right", y: 0.5, collapsed: false };
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function readAssistantPreference(raw: string | null): AssistantPreference {
  try {
    const value = JSON.parse(raw ?? "");
    if ((value.side === "left" || value.side === "right") && Number.isFinite(value.y) && typeof value.collapsed === "boolean") {
      return { side: value.side, y: clamp(value.y, 0, 1), collapsed: value.collapsed };
    }
  } catch { /* A missing or obsolete preference uses the unobtrusive default. */ }
  return DEFAULT_ASSISTANT_POSITION;
}

export function assistantBounds(viewport: AssistantViewport, collapsed: boolean) {
  const width = Math.min(collapsed ? 76 : 184, Math.max(0, viewport.width - 24));
  const height = 44;
  const left = viewport.left + 12;
  const right = Math.max(left, viewport.left + viewport.width - width - 12);
  // Keep the launcher outside the top navigation and bottom pagination/actions.
  // Very short visual viewports (keyboard/zoom) still keep the control on screen.
  const top = viewport.top + Math.min(76, Math.max(0, viewport.height - height - 12));
  const bottom = Math.max(top, viewport.top + viewport.height - height - 88);
  return { left, right, top, bottom, width, height };
}

export function clampAssistantPoint(point: AssistantPoint, viewport: AssistantViewport, collapsed: boolean): AssistantPoint {
  const bounds = assistantBounds(viewport, collapsed);
  return { x: clamp(point.x, bounds.left, bounds.right), y: clamp(point.y, bounds.top, bounds.bottom) };
}

export function assistantPoint(preference: AssistantPreference, viewport: AssistantViewport): AssistantPoint {
  const bounds = assistantBounds(viewport, preference.collapsed);
  return { x: preference.side === "left" ? bounds.left : bounds.right, y: bounds.top + preference.y * (bounds.bottom - bounds.top) };
}

export function dockAssistant(point: AssistantPoint, viewport: AssistantViewport, collapsed: boolean): AssistantPreference {
  const bounds = assistantBounds(viewport, collapsed);
  const bounded = clampAssistantPoint(point, viewport, collapsed);
  return {
    side: bounded.x <= (bounds.left + bounds.right) / 2 ? "left" : "right",
    y: bounds.bottom === bounds.top ? 0.5 : (bounded.y - bounds.top) / (bounds.bottom - bounds.top),
    collapsed
  };
}

export function assistantPanel(preference: AssistantPreference, viewport: AssistantViewport) {
  const width = Math.min(390, Math.max(0, viewport.width - 24));
  const height = Math.min(570, Math.max(0, viewport.height - 24));
  return {
    left: preference.side === "left" ? viewport.left + 12 : viewport.left + viewport.width - width - 12,
    top: clamp(assistantPoint(preference, viewport).y, viewport.top + 12, viewport.top + viewport.height - height - 12),
    width,
    height
  };
}
