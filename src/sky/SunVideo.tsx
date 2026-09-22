// The boiling sun on native: not yet. It needs a masked video view
// (expo-video behind a radial mask), which the web build does with CSS.
// Until then the native build shows the live still.
export function SunVideo(_props: { size: number; disc: number; high: number; nowMs: number }) {
  return null;
}
