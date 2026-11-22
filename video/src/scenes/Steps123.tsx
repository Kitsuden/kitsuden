import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { c, ease, enter, font, grad, lerp, p, typed } from "../theme";
import { Callout, Caret, Cursor, Win } from "../ui";

const mono: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: 25,
  lineHeight: 1.62,
  whiteSpace: "pre",
};

/* ───────────────────────── 1 · install ───────────────────────── */
const CMD = "git clone https://github.com/Kitsuden/kitsuden.git && cd kitsuden && ./install.sh";

export const Install: React.FC = () => {
  const f = useCurrentFrame();
  const shown = typed(CMD, f, 44, 62);
  const done = shown.length === CMD.length;
  const build = p(f, 128, 52, ease.inOut);
  const line = (at: number, node: React.ReactNode) => (
    <div style={enter(p(f, at, 10), 10)}>{node}</div>
  );
  const ok = <span style={{ color: c.green }}>✓ </span>;
  const box = p(f, 186, 16);
  return (
    <AbsoluteFill>
      <Win title="~/code — zsh" kind="term" x={230} y={130} w={1460} h={720} t={p(f, 0, 20)}>
        <div style={{ ...mono, padding: "26px 34px", color: c.text }}>
          <div style={{ whiteSpace: "pre-wrap" }}>
            <span style={{ color: c.crimson }}>$ </span>
            {shown}
            {!done && f > 40 && <Caret />}
          </div>
          {line(
            100,
            <>
              {ok}
              <span style={{ color: c.muted }}>Docker is running</span>
            </>
          )}
          {line(
            112,
            <>
              {ok}
              <span style={{ color: c.muted }}>
                Wrote every secret to .env, generated on this machine
              </span>
            </>
          )}
          {line(
            124,
            <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
              <span>
                {build < 1 ? <span style={{ color: c.amber }}>◌ </span> : ok}
                <span style={{ color: c.muted }}>Building the images</span>
              </span>
              <span
                style={{
                  width: 380,
                  height: 12,
                  borderRadius: 6,
                  background: "rgba(255,255,255,0.08)",
                  overflow: "hidden",
                }}
              >
                <span
                  style={{
                    display: "block",
                    width: `${build * 100}%`,
                    height: "100%",
                    backgroundImage: grad,
                  }}
                />
              </span>
              <span
                style={{
                  fontSize: 19,
                  color: c.amber,
                  border: `1px solid ${c.amber}66`,
                  borderRadius: 6,
                  padding: "0 10px",
                }}
              >
                5–15 min the first time · sped up
              </span>
            </div>
          )}
          {line(
            176,
            <>
              {ok}
              <span style={{ color: c.muted }}>
                PostgreSQL 16 + pgvector, the API and the panel are up
              </span>
            </>
          )}
          <div
            style={{
              marginTop: 18,
              padding: "16px 24px",
              borderRadius: 12,
              border: `1px solid ${c.line}`,
              background: "rgba(255,255,255,0.03)",
              ...enter(box, 16),
            }}
          >
            <div style={{ fontWeight: 700 }}>Kitsuden is running.</div>
            <div style={{ color: c.muted }}>1. Open the panel and create your administrator:</div>
            <div>
              {"     "}
              <span style={{ color: c.indigo }}>http://localhost:3001</span>
            </div>
            <div style={{ color: c.muted }}>
              {"   "}One-time setup token: <span style={{ color: c.text }}>3f9c-41d8-7a2e</span>
            </div>
            <div style={{ color: c.muted }}>
              2. In the panel, go to Agents, create one and copy its key.
            </div>
            <div style={{ color: c.muted }}>
              3. Point your MCP client at:{" "}
              <span style={{ color: c.indigo }}>http://localhost:3000/api/mcp</span>
            </div>
          </div>
        </div>
      </Win>
      <Callout
        x={326}
        y={512}
        w={1320}
        h={92}
        t={p(f, 205, 14)}
        label="Keep these two: you need them next"
      />
    </AbsoluteFill>
  );
};

/* ───────────────────────── 2 · declare a model ───────────────────────── */
type Seg = [string, string?];
const K = c.violet;
const S = "#7EE0B8";
const CM = c.dim;
const CODE: Seg[][] = [
  [["export const ", K], ["note = defineModel({"]],
  [["  name: "], ['"note"', S], [","]],
  [["  fields: {"]],
  [["    title: field.text({ max: 200, required: "], ["true", K], [" }),"]],
  [["    body: field.longText(),"]],
  [["    pinned: field.boolean({ defaultValue: "], ["false", K], [" }),"]],
  [["  },"]],
  [
    ["  access: { read: "],
    ['"owner"', S],
    [", write: "],
    ['"owner"', S],
    [" },"],
    [" // required", CM],
  ],
  [["});"]],
];

const Code: React.FC<{ chars: number }> = ({ chars }) => {
  let left = chars;
  return (
    <>
      {CODE.map((ln, i) => (
        <div key={i} style={{ minHeight: "1.62em" }}>
          {ln.map(([txt, col], j) => {
            if (left <= 0) return null;
            const part = txt.slice(0, left);
            left -= txt.length;
            return (
              <span key={j} style={{ color: col ?? c.text }}>
                {part}
              </span>
            );
          })}
          {(() => {
            left -= 1;
            return null;
          })()}
        </div>
      ))}
    </>
  );
};

const OUTPUTS: { title: string; body: React.ReactNode }[] = [
  {
    title: "REST API",
    body: (
      <>
        <span style={{ color: c.violet }}>GET</span> /api/notes/notes{"   "}
        <span style={{ color: c.violet }}>POST</span> …{"\n"}
        <span style={{ color: c.dim }}>OpenAPI 3.1 at /api/docs</span>
      </>
    ),
  },
  {
    title: "MCP tools",
    body: (
      <>
        notes__list-notes <span style={{ color: c.dim }}>note:read</span>
        {"\n"}notes__create-note <span style={{ color: c.dim }}>note:write</span>
      </>
    ),
  },
  {
    title: "Admin form",
    body: (
      <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span
          style={{
            border: `1px solid ${c.line}`,
            borderRadius: 6,
            padding: "0 12px",
            color: c.muted,
          }}
        >
          Title
        </span>
        <span
          style={{
            border: `1px solid ${c.line}`,
            borderRadius: 6,
            padding: "0 12px",
            color: c.muted,
          }}
        >
          Body
        </span>
        <span style={{ color: c.green }}>☑ Pinned</span>
      </span>
    ),
  },
  {
    title: "Typed SDK",
    body: (
      <>
        <span style={{ color: c.violet }}>await</span> kitsuden.notes.createNote(…)
      </>
    ),
  },
];

export const Model: React.FC = () => {
  const f = useCurrentFrame();
  const chars = Math.floor(Math.max(0, f - 44) * 3.1);
  const total = CODE.flat().reduce((n, s) => n + s[0].length, 0) + CODE.length;
  return (
    <AbsoluteFill>
      <Win
        title="kon-notes/src/note.model.ts"
        kind="code"
        x={100}
        y={150}
        w={940}
        h={560}
        t={p(f, 0, 20)}
      >
        <div style={{ ...mono, fontSize: 24, padding: "26px 30px" }}>
          <Code chars={chars} />
          {chars < total && f > 40 && <Caret />}
        </div>
      </Win>
      <Callout
        x={118}
        y={510}
        w={900}
        h={44}
        t={p(f, 150, 14)}
        label="Required. No rule means no — enforced by PostgreSQL RLS"
        below
      />
      <svg style={{ position: "absolute", inset: 0 }} width={1920} height={1080}>
        <defs>
          <linearGradient id="wire" x1="0" x2="1">
            <stop offset="0" stopColor={c.indigo} />
            <stop offset="1" stopColor={c.crimson} />
          </linearGradient>
        </defs>
        {OUTPUTS.map((_, i) => {
          const t = p(f, 200 + i * 14, 22, ease.inOut);
          const y2 = 225 + i * 162;
          const d = `M1040 430 C 1110 430, 1100 ${y2}, 1170 ${y2}`;
          return (
            <path
              key={i}
              d={d}
              fill="none"
              stroke="url(#wire)"
              strokeWidth={3}
              pathLength={1}
              strokeDasharray="1"
              strokeDashoffset={1 - t}
              opacity={0.9}
            />
          );
        })}
      </svg>
      {OUTPUTS.map((o, i) => {
        const t = p(f, 212 + i * 14, 18);
        return (
          <div
            key={o.title}
            style={{
              position: "absolute",
              left: 1170,
              top: 160 + i * 162,
              width: 650,
              height: 132,
              borderRadius: 16,
              background: c.surface,
              border: `1px solid ${c.line}`,
              padding: "16px 24px",
              boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
              ...enter(t, 20),
              transform: `translateX(${(1 - t) * 30}px)`,
            }}
          >
            <div
              style={{
                fontFamily: font.display,
                fontWeight: 700,
                fontSize: 28,
                color: c.text,
                marginBottom: 6,
              }}
            >
              {o.title}
            </div>
            <div style={{ ...mono, fontSize: 21, lineHeight: 1.5, color: c.text }}>{o.body}</div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ───────────────────────── 3 · an agent with its own key ───────────────────────── */
const Chip: React.FC<{ on: boolean; label: string; x: number; locked?: boolean }> = ({
  on,
  label,
  x,
  locked,
}) => (
  <div
    style={{
      position: "absolute",
      left: x,
      top: 470,
      width: 200,
      height: 60,
      borderRadius: 12,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
      fontFamily: font.mono,
      fontSize: 22,
      color: on ? c.text : c.muted,
      border: `1.5px solid ${on ? c.green : c.line}`,
      background: on ? "rgba(61,220,151,0.10)" : "rgba(255,255,255,0.02)",
      opacity: locked ? 0.55 : 1,
    }}
  >
    <span style={{ color: on ? c.green : c.dim }}>{on ? "✓" : "○"}</span>
    {label}
  </div>
);

export const AgentKey: React.FC = () => {
  const f = useCurrentFrame();
  const read = f >= 82;
  const write = f >= 102;
  const created = f >= 147;
  const modal = p(f, 152, 16);
  const copied = f >= 197;
  const KEY = "kitsuden_agent_7f3a…c91e";
  return (
    <AbsoluteFill>
      <Win
        title="localhost:3001 / agents / new"
        kind="web"
        x={300}
        y={140}
        w={1320}
        h={700}
        t={p(f, 0, 20)}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 240,
            borderRight: `1px solid ${c.line}`,
            padding: "28px 0",
          }}
        >
          {["Dashboard", "Models", "Agents", "Approvals", "Audit log", "Kons"].map((n) => (
            <div
              key={n}
              style={{
                fontFamily: font.display,
                fontSize: 22,
                padding: "11px 28px",
                color: n === "Agents" ? c.text : c.muted,
                background: n === "Agents" ? "rgba(110,91,255,0.16)" : undefined,
                borderLeft: n === "Agents" ? `3px solid ${c.indigo}` : "3px solid transparent",
              }}
            >
              {n}
            </div>
          ))}
        </div>
      </Win>
      {/* main column, in scene coordinates so the cursor can aim at it */}
      <div style={{ position: "absolute", left: 600, top: 216, ...enter(p(f, 10, 18)) }}>
        <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 44, color: c.text }}>
          New agent
        </div>
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 300,
          fontFamily: font.display,
          fontSize: 21,
          color: c.muted,
        }}
      >
        Name
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 334,
          width: 560,
          height: 60,
          borderRadius: 12,
          border: `1.5px solid ${f > 46 && f < 76 ? c.indigo : c.line}`,
          background: "rgba(0,0,0,0.25)",
          fontFamily: font.mono,
          fontSize: 25,
          color: c.text,
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
        }}
      >
        {typed("notes-bot", f, 48, 16)}
        {f > 46 && f < 76 && <Caret />}
      </div>
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 432,
          fontFamily: font.display,
          fontSize: 21,
          color: c.muted,
        }}
      >
        Scopes <span style={{ color: c.dim }}>— only what it needs</span>
      </div>
      <Chip on={read} label="note:read" x={600} />
      <Chip on={write} label="note:write" x={820} />
      <Chip on={false} label="note:delete" x={1040} />
      <Chip on={false} label="admin" x={1260} locked />
      <div
        style={{
          position: "absolute",
          left: 600,
          top: 580,
          width: 200,
          height: 60,
          borderRadius: 12,
          backgroundImage: grad,
          color: "white",
          fontFamily: font.display,
          fontWeight: 700,
          fontSize: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          transform: `scale(${created && f < 152 ? 0.96 : 1})`,
        }}
      >
        Create agent
      </div>
      {/* the key, shown once */}
      {modal > 0 && (
        <AbsoluteFill style={{ background: `rgba(5,4,10,${0.55 * modal})` }}>
          <div
            style={{
              position: "absolute",
              left: 610,
              top: 330,
              width: 700,
              height: 300,
              borderRadius: 20,
              background: c.surface2,
              border: `1px solid ${c.line}`,
              boxShadow: `0 40px 100px rgba(0,0,0,0.6), 0 0 80px rgba(163,75,214,${0.25 * modal})`,
              padding: "30px 36px",
              ...enter(modal, 24),
            }}
          >
            <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 32, color: c.text }}>
              Key for notes-bot
            </div>
            <div style={{ fontFamily: font.display, fontSize: 20, color: c.muted, marginTop: 6 }}>
              Shown once. Revoke it any time, the other agents keep working.
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 30, alignItems: "center" }}>
              <div
                style={{
                  flex: 1,
                  fontFamily: font.mono,
                  fontSize: 26,
                  color: c.text,
                  background: "rgba(0,0,0,0.35)",
                  border: `1px solid ${c.line}`,
                  borderRadius: 12,
                  padding: "14px 18px",
                }}
              >
                {KEY}
              </div>
              <div
                style={{
                  width: 130,
                  height: 58,
                  borderRadius: 12,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontFamily: font.display,
                  fontWeight: 700,
                  fontSize: 22,
                  color: copied ? c.bg : c.text,
                  background: copied ? c.green : "rgba(255,255,255,0.08)",
                }}
              >
                {copied ? "Copied" : "Copy"}
              </div>
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 19, color: c.dim, marginTop: 22 }}>
              scopes: note:read, note:write · own rate limit
            </div>
          </div>
        </AbsoluteFill>
      )}
      <Cursor
        frame={f}
        path={[
          { f: 58, x: 1500, y: 760 },
          { f: 80, x: 690, y: 492 },
          { f: 100, x: 910, y: 492 },
          { f: 140, x: 690, y: 602 },
          { f: 188, x: 1240, y: 520 },
        ]}
        clicks={[82, 102, 145, 195]}
      />
      {/* the key lifts off: it is the only thing the agent will ever hold */}
      {f > 214 && (
        <div
          style={{
            position: "absolute",
            left: lerp(p(f, 214, 40, ease.inOut), 640, 760),
            top: lerp(p(f, 214, 40, ease.inOut), 450, 900),
            fontFamily: font.mono,
            fontSize: 24,
            color: c.text,
            padding: "10px 18px",
            borderRadius: 999,
            backgroundImage: grad,
            boxShadow: "0 0 40px rgba(255,61,94,0.5)",
            opacity: 1 - p(f, 248, 14),
          }}
        >
          {KEY}
        </div>
      )}
    </AbsoluteFill>
  );
};
