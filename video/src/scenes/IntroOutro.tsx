import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { c, ease, enter, font, lerp, p } from "../theme";
import { GradText, Logo } from "../ui";

export const Intro: React.FC = () => {
  const f = useCurrentFrame();
  const logo = p(f, 0, 32);
  const out = p(f, 128, 22, ease.in);
  const word = "Kitsuden";
  const pulse = 0.55 + 0.25 * Math.sin(f / 9);
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center", opacity: 1 - out }}>
      <div
        style={{
          transform: `translateY(${-out * 40}px)`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div
          style={{
            opacity: logo,
            transform: `scale(${lerp(logo, 0.9, 1)})`,
            filter: `blur(${(1 - logo) * 14}px)`,
          }}
        >
          <Logo size={330} glow={pulse} />
        </div>
        <div style={{ display: "flex", marginTop: 18 }}>
          {word.split("").map((ch, i) => {
            const t = p(f, 22 + i * 3, 18);
            return (
              <span
                key={i}
                style={{
                  fontFamily: font.display,
                  fontWeight: 700,
                  fontSize: 120,
                  letterSpacing: -3,
                  color: c.text,
                  display: "inline-block",
                  ...enter(t, 40),
                }}
              >
                {ch}
              </span>
            );
          })}
        </div>
        <div
          style={{
            fontFamily: font.display,
            fontSize: 40,
            color: c.muted,
            marginTop: 6,
            ...enter(p(f, 55, 20)),
          }}
        >
          The backend your AI agent talks to.{" "}
          <GradText style={{ fontWeight: 700 }}>Six steps, one minute.</GradText>
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const Outro: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
      <div style={{ ...enter(p(f, 0, 24)), marginBottom: 26 }}>
        <Logo size={190} glow={0.55 + 0.2 * Math.sin(f / 10)} />
      </div>
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 700,
          fontSize: 92,
          letterSpacing: -2.5,
          lineHeight: 1.04,
          textAlign: "center",
          color: c.text,
        }}
      >
        <div style={enter(p(f, 10, 22))}>Your agent gets a key,</div>
        <div style={enter(p(f, 20, 22))}>
          <GradText>not the database password.</GradText>
        </div>
      </div>
      <div
        style={{
          marginTop: 46,
          fontFamily: font.mono,
          fontSize: 30,
          color: c.text,
          background: c.surface,
          border: `1px solid ${c.line}`,
          borderRadius: 14,
          padding: "18px 30px",
          ...enter(p(f, 42, 20)),
        }}
      >
        <span style={{ color: c.crimson }}>$ </span>git clone
        https://github.com/Kitsuden/kitsuden.git && cd kitsuden && ./install.sh
      </div>
      <div
        style={{
          marginTop: 26,
          fontFamily: font.mono,
          fontSize: 24,
          color: c.muted,
          ...enter(p(f, 60, 20)),
        }}
      >
        github.com/Kitsuden/kitsuden · MIT licensed · beta 0.9.0 · needs Docker
      </div>
    </AbsoluteFill>
  );
};
