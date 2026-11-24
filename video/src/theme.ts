import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadDisplay } from "@remotion/google-fonts/SpaceGrotesk";
import { Easing, interpolate } from "remotion";

const display = loadDisplay("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });
const mono = loadMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] });

export const font = { display: display.fontFamily, mono: mono.fontFamily };

/** Colours taken from the kitsune logo: indigo at the ears, crimson at the chin. */
export const c = {
  bg: "#0A0910",
  surface: "#13111B",
  surface2: "#1A1724",
  line: "rgba(255,255,255,0.09)",
  text: "#F4F2F8",
  muted: "#9C97AE",
  dim: "#5F5A72",
  indigo: "#6E5BFF",
  violet: "#A34BD6",
  crimson: "#FF3D5E",
  red: "#E0102F",
  green: "#3DDC97",
  amber: "#FFB547",
};

export const grad = "linear-gradient(120deg, #6E5BFF 0%, #A34BD6 42%, #FF3D5E 78%, #E0102F 100%)";

export const ease = {
  out: Easing.bezier(0.23, 1, 0.32, 1),
  inOut: Easing.bezier(0.77, 0, 0.175, 1),
  in: Easing.bezier(0.55, 0, 1, 0.45),
};

/** 0→1 between `start` and `start + dur`, eased and clamped. */
export const p = (frame: number, start: number, dur: number, e = ease.out) =>
  interpolate(frame, [start, start + dur], [0, 1], {
    easing: e,
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

export const lerp = (t: number, a: number, b: number) => a + (b - a) * t;

/** Standard entrance: rises a little, sharpens, never scales from zero. */
export const enter = (t: number, dist = 28): React.CSSProperties => ({
  opacity: t,
  transform: `translateY(${(1 - t) * dist}px) scale(${0.97 + 0.03 * t})`,
  filter: t < 1 ? `blur(${(1 - t) * 8}px)` : undefined,
});

/** Characters of `text` typed since `start`, at `cps` characters per second (30 fps). */
export const typed = (text: string, frame: number, start: number, cps = 40) =>
  text.slice(0, Math.max(0, Math.floor(((frame - start) / 30) * cps)));
