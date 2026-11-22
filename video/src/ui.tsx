import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import data from "../../site/media/tutorial-chapters.json";
import { c, ease, enter, font, grad, lerp, p } from "./theme";

export type Chapter = (typeof data.chapters)[number];
export const chapters = data.chapters;
export const TOTAL = chapters.reduce((n, ch) => Math.max(n, ch.start + ch.frames), 0);
export const chapter = (id: string) => chapters.find((ch) => ch.id === id)!;

/* ── backdrop: the logo's two colours as slow light, a dot grid, a vignette ── */
export const Backdrop: React.FC<{ drift?: number }> = ({ drift = 0 }) => {
  const f = useCurrentFrame() + drift;
  const a = Math.sin(f / 90) * 60;
  const b = Math.cos(f / 110) * 60;
  return (
    <AbsoluteFill style={{ background: c.bg }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(900px 620px at ${18 + a / 30}% ${8 + b / 40}%, rgba(110,91,255,0.20), transparent 70%),
             radial-gradient(900px 700px at ${88 - b / 30}% ${96 + a / 40}%, rgba(224,16,47,0.18), transparent 70%)`,
        }}
      />
      <AbsoluteFill
        style={{
          backgroundImage: "radial-gradient(rgba(255,255,255,0.07) 1.2px, transparent 1.2px)",
          backgroundSize: "36px 36px",
          backgroundPosition: `${(f * 0.15) % 36}px 0px`,
          maskImage: "radial-gradient(ellipse at center, black 30%, transparent 78%)",
          WebkitMaskImage: "radial-gradient(ellipse at center, black 30%, transparent 78%)",
        }}
      />
    </AbsoluteFill>
  );
};

export const Logo: React.FC<{ size: number; glow?: number; style?: React.CSSProperties }> = ({
  size,
  glow = 0.6,
  style,
}) => (
  <Img
    src={staticFile("kitsuden-logo.png")}
    style={{
      width: size,
      height: size,
      filter: `drop-shadow(0 0 ${size * 0.08}px rgba(163,75,214,${glow}))`,
      ...style,
    }}
  />
);

export const GradText: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({
  children,
  style,
}) => (
  <span
    style={{
      backgroundImage: grad,
      WebkitBackgroundClip: "text",
      backgroundClip: "text",
      color: "transparent",
      ...style,
    }}
  >
    {children}
  </span>
);

/* ── a window: terminal, editor or browser ── */
export const Win: React.FC<{
  title: string;
  w: number;
  h: number;
  x: number;
  y: number;
  t?: number;
  kind?: "term" | "code" | "web";
  children: React.ReactNode;
  glow?: string;
}> = ({ title, w, h, x, y, t = 1, kind = "term", children, glow }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      width: w,
      height: h,
      borderRadius: 18,
      background: kind === "web" ? c.surface2 : c.surface,
      border: `1px solid ${c.line}`,
      boxShadow: `0 40px 90px rgba(0,0,0,0.55)${glow ? `, 0 0 0 1px ${glow}, 0 0 60px ${glow}` : ""}`,
      overflow: "hidden",
      ...enter(t, 40),
    }}
  >
    <div
      style={{
        height: 46,
        display: "flex",
        alignItems: "center",
        gap: 9,
        padding: "0 18px",
        borderBottom: `1px solid ${c.line}`,
        background: "rgba(255,255,255,0.02)",
      }}
    >
      {["#FF5F57", "#FEBC2E", "#28C840"].map((col) => (
        <span
          key={col}
          style={{ width: 12, height: 12, borderRadius: 6, background: col, opacity: 0.8 }}
        />
      ))}
      <span
        style={{
          marginLeft: 14,
          fontFamily: kind === "web" ? font.display : font.mono,
          fontSize: 17,
          color: c.muted,
          ...(kind === "web"
            ? {
                background: "rgba(255,255,255,0.05)",
                padding: "5px 16px",
                borderRadius: 8,
                flex: 1,
              }
            : {}),
        }}
      >
        {title}
      </span>
    </div>
    <div style={{ position: "relative", height: h - 46 }}>{children}</div>
  </div>
);

export const Caret: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <span
      style={{
        display: "inline-block",
        width: "0.55em",
        height: "1.05em",
        verticalAlign: "-0.15em",
        background: c.text,
        opacity: Math.floor(f / 15) % 2 ? 0 : 0.85,
        marginLeft: 2,
      }}
    />
  );
};

/* ── the chapter slate: big number + title, then it gets out of the way ── */
export const Slate: React.FC<{ ch: Chapter; frame: number }> = ({ ch, frame }) => {
  const tin = p(frame, 0, 14);
  const tout = p(frame, 30, 12, ease.in);
  if (frame > 44) return null;
  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        background: `rgba(10,9,16,${0.92 * (1 - tout)})`,
        zIndex: 20,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 36,
          opacity: tin * (1 - tout),
          transform: `translateY(${lerp(tin, 30, 0) - tout * 40}px)`,
        }}
      >
        <GradText
          style={{ fontFamily: font.mono, fontSize: 150, fontWeight: 700, letterSpacing: -6 }}
        >
          {String(ch.n).padStart(2, "0")}
        </GradText>
        <div
          style={{
            fontFamily: font.display,
            fontSize: 92,
            fontWeight: 700,
            color: c.text,
            letterSpacing: -2,
          }}
        >
          {ch.title}
        </div>
      </div>
    </AbsoluteFill>
  );
};

/* ── HUD: logo, chapter, a six-part progress bar; the film explains where you are ── */
export const Hud: React.FC = () => {
  const f = useCurrentFrame();
  const steps = chapters.filter((ch) => ch.n >= 1 && ch.n <= 6);
  const cur = chapters.find((ch) => f >= ch.start && f < ch.start + ch.frames) ?? chapters[0];
  const show = cur.n >= 1 && cur.n <= 6;
  const vis = show
    ? p(f, chapter("install").start + 30, 16) * (1 - p(f, chapter("outro").start, 12))
    : 0;
  return (
    <AbsoluteFill style={{ opacity: vis, zIndex: 15, pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: 64,
          top: 42,
          display: "flex",
          alignItems: "center",
          gap: 14,
        }}
      >
        <Logo size={44} glow={0.4} />
        <span style={{ fontFamily: font.display, fontWeight: 700, fontSize: 26, color: c.text }}>
          Kitsuden
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 18, color: c.dim, marginLeft: 6 }}>
          / tutorial
        </span>
      </div>
      <div
        style={{
          position: "absolute",
          right: 64,
          top: 48,
          fontFamily: font.mono,
          fontSize: 20,
          color: c.muted,
          display: "flex",
          gap: 14,
        }}
      >
        <span style={{ color: c.text }}>Step {cur.n} of 6</span>
        <span>·</span>
        <span>{cur.title}</span>
      </div>
      <div
        style={{ position: "absolute", left: 64, right: 64, bottom: 40, display: "flex", gap: 10 }}
      >
        {steps.map((s) => {
          const fill = interpolate(f, [s.start, s.start + s.frames], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          });
          return (
            <div
              key={s.id}
              style={{ flex: 1, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.08)" }}
            >
              <div
                style={{
                  width: `${fill * 100}%`,
                  height: "100%",
                  borderRadius: 3,
                  backgroundImage: grad,
                }}
              />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ── captions, one beat at a time, from the same JSON the page reads ── */
export const Captions: React.FC = () => {
  const f = useCurrentFrame();
  const cur = chapters.find((ch) => f >= ch.start && f < ch.start + ch.frames);
  if (!cur || cur.n < 1 || cur.n > 6) return null;
  const local = f - cur.start;
  const beats = cur.beats;
  let i = -1;
  for (let k = 0; k < beats.length; k++) if (local >= beats[k].at + (k === 0 ? 40 : 0)) i = k;
  if (i < 0) return null;
  const at = beats[i].at + (i === 0 ? 40 : 0);
  const end = i + 1 < beats.length ? beats[i + 1].at : cur.frames;
  const t = p(local, at, 12) * (1 - p(local, end - 8, 8, ease.in));
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 78,
        display: "flex",
        justifyContent: "center",
        zIndex: 16,
      }}
    >
      <div
        style={{
          fontFamily: font.display,
          fontSize: 34,
          fontWeight: 500,
          color: c.text,
          background: "rgba(10,9,16,0.78)",
          border: `1px solid ${c.line}`,
          padding: "14px 30px",
          borderRadius: 14,
          ...enter(t, 14),
        }}
      >
        {beats[i].text}
      </div>
    </div>
  );
};

/* ── a rubber stamp: 200 OK, 403 DENIED, APPROVED ── */
export const Stamp: React.FC<{
  text: string;
  color: string;
  t: number;
  rot?: number;
  size?: number;
}> = ({ text, color, t, rot = -8, size = 44 }) => (
  <div
    style={{
      display: "inline-block",
      fontFamily: font.mono,
      fontWeight: 700,
      fontSize: size,
      letterSpacing: 3,
      color,
      border: `4px solid ${color}`,
      borderRadius: 12,
      padding: "6px 20px",
      opacity: t,
      transform: `rotate(${rot}deg) scale(${lerp(t, 1.5, 1)})`,
      boxShadow: `0 0 ${30 * t}px ${color}55, inset 0 0 18px ${color}22`,
      background: "rgba(10,9,16,0.6)",
    }}
  >
    {text}
  </div>
);

/* ── a pointer that glides to a target and clicks ── */
export const Cursor: React.FC<{
  frame: number;
  path: { f: number; x: number; y: number }[];
  clicks?: number[];
}> = ({ frame, path, clicks = [] }) => {
  const fs = path.map((q) => q.f);
  const x = interpolate(
    frame,
    fs,
    path.map((q) => q.x),
    { easing: ease.inOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const y = interpolate(
    frame,
    fs,
    path.map((q) => q.y),
    { easing: ease.inOut, extrapolateLeft: "clamp", extrapolateRight: "clamp" }
  );
  const press = clicks.reduce((m, cf) => Math.max(m, 1 - Math.abs(frame - cf) / 5), 0);
  const ring = clicks
    .map((cf) => (frame >= cf && frame < cf + 18 ? (frame - cf) / 18 : -1))
    .find((r) => r >= 0);
  return (
    <div
      style={{ position: "absolute", left: x, top: y, zIndex: 30, opacity: p(frame, path[0].f, 8) }}
    >
      {ring !== undefined && (
        <div
          style={{
            position: "absolute",
            left: -30 * ring - 4,
            top: -30 * ring - 4,
            width: 60 * ring + 8,
            height: 60 * ring + 8,
            borderRadius: "50%",
            border: `2px solid ${c.text}`,
            opacity: 1 - ring,
          }}
        />
      )}
      <svg
        width="34"
        height="34"
        viewBox="0 0 24 24"
        style={{ transform: `scale(${1 - press * 0.15})`, transformOrigin: "0 0" }}
      >
        <path
          d="M3 2l7 19 2.6-7.6L20 11z"
          fill={c.text}
          stroke={c.bg}
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

/* ── a labelled callout ring around something on screen ── */
export const Callout: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  t: number;
  label: string;
  color?: string;
  below?: boolean;
}> = ({ x, y, w, h, t, label, color = c.amber, below }) => (
  <div
    style={{ position: "absolute", left: x, top: y, width: w, height: h, zIndex: 12, opacity: t }}
  >
    <div
      style={{
        position: "absolute",
        inset: 0,
        borderRadius: 12,
        border: `2.5px solid ${color}`,
        boxShadow: `0 0 26px ${color}66`,
        transform: `scale(${lerp(t, 1.08, 1)})`,
      }}
    />
    <div
      style={{
        position: "absolute",
        right: 0,
        [below ? "top" : "bottom"]: h + 12,
        fontFamily: font.display,
        fontWeight: 700,
        fontSize: 22,
        color: c.bg,
        background: color,
        padding: "6px 14px",
        borderRadius: 8,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </div>
  </div>
);
