import React from "react";
import { AbsoluteFill } from "remotion";
import { c, font, grad } from "./theme";
import { Backdrop, GradText, Logo, Stamp } from "./ui";

/**
 * GitHub's repository social preview, 1280×640 (Settings → Social preview).
 * It explains the idea in one picture: the agent holds a key, Kitsuden checks it,
 * PostgreSQL enforces row security, and you sign off on the risky part.
 */
const CX = 948;
const CY = 318;

const Check: React.FC<{ x: number; y: number; label: string; state?: "ok" | "wait" }> = ({
  x,
  y,
  label,
  state = "ok",
}) => {
  const col = state === "ok" ? c.green : c.amber;
  return (
    <div
      style={{
        position: "absolute",
        left: x,
        top: y,
        transform: "translate(-50%, -50%)",
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontFamily: font.mono,
        fontSize: 18,
        fontWeight: 700,
        color: c.text,
        padding: "8px 14px",
        borderRadius: 999,
        background: "rgba(19,17,27,0.92)",
        border: `2px solid ${col}`,
        boxShadow: `0 0 22px ${col}55`,
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ color: col }}>{state === "ok" ? "✓" : "…"}</span>
      {label}
    </div>
  );
};

const Node: React.FC<{
  x: number;
  y: number;
  title: string;
  sub: React.ReactNode;
  accent: string;
  icon: React.ReactNode;
}> = ({ x, y, title, sub, accent, icon }) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: y,
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "12px 16px",
      borderRadius: 16,
      background: "rgba(19,17,27,0.94)",
      border: `1.5px solid ${accent}88`,
      boxShadow: `0 0 30px ${accent}33, 0 20px 40px rgba(0,0,0,0.5)`,
    }}
  >
    <div
      style={{
        width: 42,
        height: 42,
        borderRadius: 12,
        display: "grid",
        placeItems: "center",
        background: `${accent}22`,
        color: accent,
      }}
    >
      {icon}
    </div>
    <div>
      <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 20, color: c.text }}>
        {title}
      </div>
      <div style={{ fontFamily: font.mono, fontSize: 14, color: c.muted, marginTop: 2 }}>{sub}</div>
    </div>
  </div>
);

const bot = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="4" y="8" width="16" height="12" rx="3" />
    <path d="M12 8V4M9 13h.01M15 13h.01M9 17h6" strokeLinecap="round" />
  </svg>
);
const db = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
    <path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
  </svg>
);
const you = (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" strokeLinecap="round" />
  </svg>
);

export const RepoPreview: React.FC = () => (
  <AbsoluteFill>
    <Backdrop drift={900} />
    <AbsoluteFill
      style={{
        background: `radial-gradient(420px 420px at ${CX}px ${CY}px, rgba(163,75,214,0.30), transparent 70%)`,
      }}
    />

    {/* ── left: what it is ── */}
    <div
      style={{
        position: "absolute",
        left: 76,
        top: 86,
        display: "flex",
        alignItems: "center",
        gap: 10,
        fontFamily: font.mono,
        fontWeight: 700,
        fontSize: 18,
        color: c.text,
        padding: "8px 18px",
        borderRadius: 999,
        border: `2px solid ${c.violet}`,
        background: "rgba(110,91,255,0.12)",
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 6, background: c.green }} />
      OPEN SOURCE · MIT · BETA
    </div>
    <div
      style={{
        position: "absolute",
        left: 74,
        top: 150,
        fontFamily: font.display,
        fontWeight: 700,
        fontSize: 96,
        letterSpacing: -3,
        lineHeight: 1,
        color: c.text,
      }}
    >
      Kitsuden
    </div>
    <div
      style={{
        position: "absolute",
        left: 76,
        top: 260,
        width: 560,
        fontFamily: font.display,
        fontWeight: 700,
        fontSize: 38,
        lineHeight: 1.12,
        letterSpacing: -1,
      }}
    >
      <GradText>Your agent gets a key, not the database password.</GradText>
    </div>
    <div
      style={{
        position: "absolute",
        left: 76,
        top: 368,
        width: 560,
        fontFamily: font.display,
        fontSize: 23,
        lineHeight: 1.4,
        color: c.muted,
      }}
    >
      The self-hosted backend for apps AI agents use. One model gives you REST, GraphQL and MCP,
      behind scoped keys, row security and your sign‑off.
    </div>
    <div
      style={{
        position: "absolute",
        left: 76,
        top: 528,
        fontFamily: font.mono,
        fontWeight: 700,
        fontSize: 21,
        color: c.text,
        padding: "14px 22px",
        borderRadius: 14,
        background: "rgba(19,17,27,0.9)",
        border: `1.5px solid ${c.violet}`,
      }}
    >
      <span style={{ color: c.crimson }}>$</span> ./install.sh
      <span style={{ color: c.dim }}>{"  "}# needs Docker</span>
    </div>

    {/* ── right: how it works ── */}
    <svg style={{ position: "absolute", inset: 0 }} width={1280} height={640}>
      <defs>
        <linearGradient id="w1" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor={c.indigo} />
          <stop offset="1" stopColor={c.crimson} />
        </linearGradient>
        <linearGradient id="ring" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#6E5BFF" />
          <stop offset="0.5" stopColor="#A34BD6" />
          <stop offset="1" stopColor="#E0102F" />
        </linearGradient>
      </defs>
      {/* the orbit the checks sit on */}
      <ellipse
        cx={CX}
        cy={CY}
        rx={232}
        ry={196}
        fill="none"
        stroke="url(#w1)"
        strokeOpacity={0.45}
        strokeWidth={1.5}
      />
      <ellipse
        cx={CX}
        cy={CY}
        rx={290}
        ry={250}
        fill="none"
        stroke={c.violet}
        strokeOpacity={0.18}
        strokeWidth={1}
        strokeDasharray="4 8"
      />
      {/* agent → kitsuden → postgres, and kitsuden ↔ you */}
      <path
        d={`M770 108 C 820 150, 860 190, ${CX - 70} ${CY - 90}`}
        fill="none"
        stroke="url(#w1)"
        strokeWidth={3}
        strokeDasharray="10 8"
      />
      <path
        d={`M${CX + 80} ${CY + 86} C 1080 470, 1110 490, 1130 520`}
        fill="none"
        stroke="url(#w1)"
        strokeWidth={3}
        strokeDasharray="10 8"
      />
      <path
        d={`M${CX - 86} ${CY + 80} C 840 470, 820 495, 790 520`}
        fill="none"
        stroke={c.amber}
        strokeOpacity={0.8}
        strokeWidth={2.5}
        strokeDasharray="6 7"
      />
      {/* the ring around the mask */}
      <circle
        cx={CX}
        cy={CY}
        r={124}
        fill="rgba(10,9,16,0.85)"
        stroke="url(#ring)"
        strokeWidth={9}
      />
      <circle
        cx={CX}
        cy={CY}
        r={138}
        fill="none"
        stroke="url(#ring)"
        strokeOpacity={0.35}
        strokeWidth={2}
      />
    </svg>
    <div
      style={{
        position: "absolute",
        left: CX - 124,
        top: CY - 124,
        width: 248,
        height: 248,
        borderRadius: "50%",
        boxShadow: "0 0 70px rgba(163,75,214,0.65), 0 0 140px rgba(224,16,47,0.35)",
      }}
    />
    <div style={{ position: "absolute", left: CX - 92, top: CY - 98 }}>
      <Logo size={184} glow={0.75} />
    </div>

    <Check x={CX} y={CY - 196} label="key" />
    <Check x={CX + 232} y={CY - 40} label="scope" />
    <Check x={CX + 196} y={CY + 118} label="policy" />
    <Check x={CX - 232} y={CY - 10} label="audit log" />

    <Node
      x={642}
      y={44}
      title="Your agent"
      sub="kitsuden_agent_7f3a…"
      accent={c.indigo}
      icon={bot}
    />
    <Node
      x={1000}
      y={508}
      title="PostgreSQL"
      sub="row-level security"
      accent={c.crimson}
      icon={db}
    />
    <Node x={642} y={508} title="You" sub="sign off on DELETE" accent={c.amber} icon={you} />
    <div style={{ position: "absolute", left: 786, top: 452 }}>
      <Stamp text="APPROVED" color={c.green} t={1} rot={-8} size={22} />
    </div>
    <div
      style={{
        position: "absolute",
        right: 34,
        top: 40,
        fontFamily: font.mono,
        fontSize: 15,
        color: c.dim,
        textAlign: "right",
        lineHeight: 1.5,
      }}
    >
      MCP · REST · GraphQL
      <br />
      <span style={{ backgroundImage: grad, WebkitBackgroundClip: "text", color: "transparent" }}>
        + installable kons
      </span>
    </div>
  </AbsoluteFill>
);
