import React from "react";
import { AbsoluteFill } from "remotion";
import { c, font, grad } from "./theme";
import { Backdrop, GradText, Logo, Stamp } from "./ui";

const STEPS = ["Install", "Model", "Key", "Connect", "Checks", "Approve"];

/** The social card, 1200×630. Rendered with `remotion still`, so it shares the film's look. */
export const OgImage: React.FC = () => (
  <AbsoluteFill>
    <Backdrop drift={400} />
    <div style={{ position: "absolute", right: -40, top: 40, opacity: 0.95 }}>
      <Logo size={560} glow={0.7} />
    </div>
    <AbsoluteFill
      style={{
        background:
          "linear-gradient(90deg, rgba(10,9,16,0.96) 0%, rgba(10,9,16,0.88) 58%, rgba(10,9,16,0.1) 85%)",
      }}
    />
    <div
      style={{
        position: "absolute",
        left: 68,
        top: 56,
        display: "flex",
        alignItems: "center",
        gap: 14,
      }}
    >
      <Logo size={50} glow={0.4} />
      <span style={{ fontFamily: font.display, fontWeight: 700, fontSize: 34, color: c.text }}>
        Kitsuden
      </span>
      <span
        style={{
          marginLeft: 8,
          fontFamily: font.mono,
          fontSize: 17,
          color: c.muted,
          border: `1px solid ${c.line}`,
          borderRadius: 999,
          padding: "4px 14px",
        }}
      >
        open source · MIT
      </span>
    </div>
    <div
      style={{
        position: "absolute",
        left: 68,
        top: 168,
        width: 900,
        fontFamily: font.display,
        fontWeight: 700,
        fontSize: 58,
        lineHeight: 1.02,
        letterSpacing: -2,
        color: c.text,
      }}
    >
      Your agent gets a key,
      <br />
      <GradText>not the database password.</GradText>
    </div>
    <div
      style={{
        position: "absolute",
        left: 68,
        top: 318,
        width: 600,
        fontFamily: font.display,
        fontSize: 25,
        lineHeight: 1.4,
        color: c.muted,
      }}
    >
      The self-hosted backend for apps that AI agents use: scoped keys, row-level security, an audit
      log and your sign-off.
    </div>
    <div
      style={{
        position: "absolute",
        left: 68,
        bottom: 58,
        display: "flex",
        alignItems: "center",
        gap: 10,
      }}
    >
      {STEPS.map((s, i) => (
        <React.Fragment key={s}>
          <span
            style={{
              fontFamily: font.mono,
              fontSize: 17,
              color: c.text,
              background: "rgba(255,255,255,0.05)",
              border: `1px solid ${c.line}`,
              borderRadius: 10,
              padding: "7px 12px",
            }}
          >
            <span style={{ color: c.crimson }}>{String(i + 1).padStart(2, "0")}</span> {s}
          </span>
          {i < STEPS.length - 1 && <span style={{ width: 12, height: 2, backgroundImage: grad }} />}
        </React.Fragment>
      ))}
    </div>
    <div style={{ position: "absolute", right: 70, bottom: 120 }}>
      <Stamp text="APPROVED" color={c.green} t={1} rot={-9} size={36} />
    </div>
  </AbsoluteFill>
);
