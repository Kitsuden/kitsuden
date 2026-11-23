import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { c, ease, enter, font, grad, lerp, p, typed } from "../theme";
import { Caret, Cursor, Stamp, Win } from "../ui";

const mono: React.CSSProperties = {
  fontFamily: font.mono,
  fontSize: 24,
  lineHeight: 1.6,
  whiteSpace: "pre",
};

/* ───────────────────────── 4 · connect over MCP ───────────────────────── */
export const Connect: React.FC = () => {
  const f = useCurrentFrame();
  const fly = p(f, 96, 34, ease.inOut);
  const lit = f >= 130;
  const tools = (i: number) => enter(p(f, 172 + i * 9, 12), 10);
  return (
    <AbsoluteFill>
      <Win title=".mcp.json" kind="code" x={100} y={140} w={880} h={520} t={p(f, 0, 20)}>
        <div
          style={{
            ...mono,
            fontSize: 22,
            padding: "20px 30px",
            color: c.text,
            opacity: p(f, 30, 14),
          }}
        >
          {`{\n  "mcpServers": {\n    "kitsuden": {\n      "command": "kitsuden",\n      "args": ["mcp", "--stdio"],\n      "env": {\n        "KITSUDEN_API_URL": "\${KITSUDEN_API_URL}",\n        "KITSUDEN_API_TOKEN": `}
          <span
            style={{
              color: lit ? c.text : "#7EE0B8",
              background: lit ? "rgba(255,61,94,0.22)" : undefined,
              boxShadow: lit ? `0 0 0 2px ${c.crimson}` : undefined,
              borderRadius: 6,
            }}
          >
            "${"{KITSUDEN_API_TOKEN}"}"
          </span>
          {`\n      }\n    }\n  }\n}`}
        </div>
      </Win>
      <Win
        title="terminal — before starting the agent"
        kind="term"
        x={100}
        y={690}
        w={880}
        h={130}
        t={p(f, 70, 16)}
      >
        <div style={{ ...mono, padding: "20px 30px", color: c.text }}>
          <span style={{ color: c.crimson }}>$ </span>export KITSUDEN_API_TOKEN=
          <span style={{ color: c.amber }}>kitsuden_agent_7f3a…</span>
        </div>
      </Win>
      {fly > 0 && fly < 1 && (
        <div
          style={{
            position: "absolute",
            left: lerp(fly, 520, 560),
            top: lerp(fly, 740, 474) - Math.sin(fly * Math.PI) * 120,
            fontFamily: font.mono,
            fontSize: 22,
            color: "white",
            padding: "8px 16px",
            borderRadius: 999,
            backgroundImage: grad,
            boxShadow: "0 0 40px rgba(255,61,94,0.55)",
          }}
        >
          agent key
        </div>
      )}
      <Win
        title="Claude Code — ~/my-app"
        kind="term"
        x={1030}
        y={150}
        w={790}
        h={660}
        t={p(f, 140, 18)}
      >
        <div
          style={{
            ...mono,
            fontSize: 23,
            padding: "24px 30px",
            color: c.text,
            whiteSpace: "pre-wrap",
          }}
        >
          <div>
            <span style={{ color: c.violet }}>&gt; </span>
            {typed("what can you do with my notes?", f, 150, 45)}
            {f > 148 && f < 172 && <Caret />}
          </div>
          <div style={{ color: c.muted, marginTop: 12, ...tools(0) }}>
            MCP kitsuden · connected as notes-bot
          </div>
          <div style={tools(1)}>
            <span style={{ color: c.green }}>✓ </span>notes__list-notes
          </div>
          <div style={tools(2)}>
            <span style={{ color: c.green }}>✓ </span>notes__get-note
          </div>
          <div style={tools(3)}>
            <span style={{ color: c.green }}>✓ </span>notes__create-note
          </div>
          <div style={tools(4)}>
            <span style={{ color: c.green }}>✓ </span>notes__update-note
          </div>
          <div style={{ color: c.dim, ...tools(5) }}>
            ○ delete and admin tools: not listed,{"\n"} this key has no scope for them
          </div>
        </div>
      </Win>
    </AbsoluteFill>
  );
};

/* ───────────────────────── shared: the gates a request walks through ───────────────────────── */
type GateState = "idle" | "pass" | "fail" | "wait";
const gateColor = (s: GateState) =>
  s === "pass" ? c.green : s === "fail" ? c.crimson : s === "wait" ? c.amber : c.line;

const Gate: React.FC<{
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  note: string;
  s: GateState;
}> = ({ x, y, w, h, name, note, s }) => {
  const col = gateColor(s);
  return (
    <div
      style={{
        position: "absolute",
        left: x - w / 2,
        top: y,
        width: w,
        height: h,
        borderRadius: 16,
        border: `2px solid ${col}`,
        background: s === "idle" ? c.surface : `${col}14`,
        boxShadow: s === "idle" ? undefined : `0 0 34px ${col}44`,
        padding: "20px 20px",
      }}
    >
      <div
        style={{
          fontFamily: font.mono,
          fontSize: 30,
          color: col === c.line ? c.dim : col,
          height: 38,
        }}
      >
        {s === "pass" ? "✓" : s === "fail" ? "✕" : s === "wait" ? "…" : "·"}
      </div>
      <div
        style={{
          fontFamily: font.display,
          fontWeight: 700,
          fontSize: 27,
          color: c.text,
          marginTop: 6,
        }}
      >
        {name}
      </div>
      <div
        style={{
          fontFamily: font.display,
          fontSize: 19,
          color: c.muted,
          marginTop: 6,
          lineHeight: 1.35,
        }}
      >
        {note}
      </div>
    </div>
  );
};

const Pill: React.FC<{ x: number; y: number; text: string; t: number; shake?: number }> = ({
  x,
  y,
  text,
  t,
  shake = 0,
}) => (
  <div
    style={{
      position: "absolute",
      left: x + Math.sin(shake * 40) * 10 * shake,
      top: y,
      transform: "translateX(-50%)",
      fontFamily: font.mono,
      fontSize: 24,
      color: "white",
      padding: "10px 20px",
      borderRadius: 999,
      backgroundImage: grad,
      boxShadow: "0 0 36px rgba(163,75,214,0.55)",
      whiteSpace: "nowrap",
      opacity: t,
      zIndex: 5,
    }}
  >
    {text}
  </div>
);

/* ───────────────────────── 5 · every call is checked ───────────────────────── */
const GATES = [
  { name: "Key", note: "Who is this agent? Is the key active?" },
  { name: "Scope", note: "May this key call this operation?" },
  { name: "Policy", note: "No rule for the action means no." },
  { name: "Row security", note: "PostgreSQL returns only its rows." },
  { name: "Audit", note: "What happened is written down." },
];
const GX = [430, 690, 950, 1210, 1470];

export const Checks: React.FC = () => {
  const f = useCurrentFrame();
  // request 1: a read that passes everything
  const r1 = p(f, 46, 100, ease.inOut);
  const x1 = lerp(r1, 150, 1720);
  // request 2: a write outside the key's scopes, stopped at Scope
  const r2 = p(f, 168, 40, ease.inOut);
  const x2 = lerp(r2, 150, GX[1] - 150);
  const shake = f > 208 && f < 222 ? 1 - (f - 208) / 14 : 0;
  const second = f >= 160;
  const state = (i: number): GateState => {
    if (!second) return x1 >= GX[i] - 40 ? "pass" : "idle";
    if (i === 0) return x2 >= GX[0] - 40 ? "pass" : "idle";
    if (i === 1) return f >= 206 ? "fail" : "idle";
    if (i === 4) return f >= 262 ? "pass" : "idle";
    return "idle";
  };
  const req = second ? "POST /api/admin/agents" : "GET /api/notes/notes";
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 160,
          display: "flex",
          alignItems: "center",
          gap: 18,
          ...enter(p(f, 6, 16)),
        }}
      >
        <span style={{ fontFamily: font.display, fontSize: 28, color: c.muted }}>
          notes-bot sends
        </span>
        <span
          key={req}
          style={{
            fontFamily: font.mono,
            fontSize: 28,
            color: c.text,
            background: c.surface,
            border: `1px solid ${c.line}`,
            borderRadius: 10,
            padding: "6px 16px",
            ...enter(second ? p(f, 160, 10) : 1, 8),
          }}
        >
          {req}
        </span>
      </div>
      {GATES.map((g, i) => (
        <Gate
          key={g.name}
          x={GX[i]}
          y={270}
          w={230}
          h={240}
          name={g.name}
          note={g.note}
          s={state(i)}
        />
      ))}
      {!second && r1 > 0 && <Pill x={x1} y={540} text="GET" t={1 - p(f, 146, 10)} />}
      {second && <Pill x={x2} y={540} text="POST" t={p(f, 162, 8)} shake={shake} />}
      {/* results */}
      <div
        style={{
          position: "absolute",
          left: 120,
          top: 640,
          display: "flex",
          alignItems: "center",
          gap: 34,
        }}
      >
        {!second && f > 140 && (
          <>
            <Stamp text="200 OK" color={c.green} t={p(f, 140, 10)} />
            <div style={{ ...mono, fontSize: 24, color: c.text, ...enter(p(f, 146, 12), 10) }}>
              notes[3]{"{id,title,pinned}"}:{"\n"} 40,Ship the landing page,true{"\n"} 41,Rotate the
              bot key,false{"\n"} 42,Old draft,false
            </div>
          </>
        )}
        {second && f > 210 && (
          <>
            <Stamp text="403 DENIED" color={c.crimson} t={p(f, 210, 10)} />
            <div style={{ ...mono, fontSize: 24, color: c.text, ...enter(p(f, 216, 12), 10) }}>
              code: <span style={{ color: c.crimson }}>KITSUDEN_E_FORBIDDEN</span>
              {"\n"}retryable: false{"\n"}hint:{" "}
              <span style={{ color: c.muted }}>the key lacks the scope this operation needs</span>
            </div>
          </>
        )}
      </div>
    </AbsoluteFill>
  );
};

/* ───────────────────────── 6 · risky actions wait for you ───────────────────────── */
const AG = [
  { name: "Key", note: "active" },
  { name: "Scope", note: "note:write" },
  { name: "Policy", note: "owner" },
  { name: "Approval", note: "delete is sensitive" },
];
const AX = [180, 400, 620, 840];

export const Approve: React.FC = () => {
  const f = useCurrentFrame();
  const go = p(f, 44, 60, ease.inOut);
  const resume = p(f, 236, 30, ease.inOut);
  const x = f < 236 ? lerp(go, 60, AX[3] - 130) : lerp(resume, AX[3] - 130, 1000);
  const card = p(f, 128, 22);
  const approved = f >= 212;
  const st = (i: number): GateState => {
    if (i < 3) return x >= AX[i] - 40 ? "pass" : "idle";
    if (f >= 236) return "pass";
    return f >= 104 ? "wait" : "idle";
  };
  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: 70,
          top: 160,
          display: "flex",
          alignItems: "center",
          gap: 16,
          ...enter(p(f, 6, 16)),
        }}
      >
        <span style={{ fontFamily: font.display, fontSize: 26, color: c.muted }}>
          notes-bot sends
        </span>
        <span
          style={{
            fontFamily: font.mono,
            fontSize: 26,
            color: c.text,
            background: c.surface,
            border: `1px solid ${c.line}`,
            borderRadius: 10,
            padding: "6px 16px",
          }}
        >
          DELETE /api/notes/notes/42
        </span>
      </div>
      {AG.map((g, i) => (
        <Gate
          key={g.name}
          x={AX[i]}
          y={260}
          w={200}
          h={210}
          name={g.name}
          note={g.note}
          s={st(i)}
        />
      ))}
      <Pill x={x} y={500} text="DELETE" t={p(f, 40, 8) * (1 - p(f, 262, 8))} />
      <div
        style={{
          position: "absolute",
          left: 70,
          top: 600,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {f >= 108 && f < 236 && (
          <div
            style={{ ...enter(p(f, 108, 12), 10), display: "flex", alignItems: "center", gap: 22 }}
          >
            <Stamp text="202" color={c.amber} t={p(f, 108, 10)} size={40} />
            <span style={{ ...mono, fontSize: 23, color: c.text }}>
              KITSUDEN_E_APPROVAL_REQUIRED{"\n"}
              <span style={{ color: c.muted }}>a proposal, not a delete. Don't retry.</span>
            </span>
          </div>
        )}
        {f >= 262 && (
          <div
            style={{ ...enter(p(f, 262, 12), 10), display: "flex", alignItems: "center", gap: 22 }}
          >
            <Stamp text="200 OK" color={c.green} t={p(f, 262, 10)} size={40} />
            <span style={{ ...mono, fontSize: 23, color: c.text }}>
              proposal executed.{"\n"}
              <span style={{ color: c.muted }}>Ran once, with notes-bot's own permissions.</span>
            </span>
          </div>
        )}
      </div>
      <Win
        title="localhost:3001 / approvals"
        kind="web"
        x={1040}
        y={150}
        w={780}
        h={660}
        t={p(f, 90, 20)}
        glow={card > 0 && !approved ? "rgba(255,181,71,0.35)" : undefined}
      >
        <div style={{ padding: "26px 32px" }}>
          <div style={{ fontFamily: font.display, fontWeight: 700, fontSize: 34, color: c.text }}>
            Your inbox
          </div>
          {card === 0 && (
            <div style={{ fontFamily: font.display, fontSize: 22, color: c.dim, marginTop: 16 }}>
              Nothing is waiting for you.
            </div>
          )}
          {card > 0 && (
            <div
              style={{
                marginTop: 18,
                borderRadius: 16,
                border: `1px solid ${approved ? c.green : c.amber}88`,
                background: c.surface,
                padding: "22px 26px",
                position: "relative",
                ...enter(card, 30),
                transform: `translateX(${(1 - card) * -60}px)`,
              }}
            >
              <div style={{ fontFamily: font.display, fontSize: 25, color: c.text }}>
                <b>notes-bot</b> wants to delete a note
              </div>
              <div
                style={{
                  ...mono,
                  fontSize: 23,
                  marginTop: 14,
                  padding: "10px 16px",
                  borderRadius: 10,
                  background: "rgba(255,61,94,0.10)",
                  color: c.crimson,
                }}
              >
                - 42 · Old draft
              </div>
              <div style={{ display: "flex", gap: 14, marginTop: 20 }}>
                <div
                  style={{
                    fontFamily: font.display,
                    fontSize: 22,
                    padding: "10px 24px",
                    borderRadius: 10,
                    border: `1px solid ${c.line}`,
                    color: c.muted,
                  }}
                >
                  Reject
                </div>
                <div
                  style={{
                    fontFamily: font.display,
                    fontWeight: 700,
                    fontSize: 22,
                    padding: "10px 24px",
                    borderRadius: 10,
                    color: "white",
                    backgroundImage: grad,
                    transform: `scale(${f >= 206 && f < 214 ? 0.95 : 1})`,
                  }}
                >
                  Approve
                </div>
              </div>
              {approved && (
                <div style={{ position: "absolute", right: 26, top: 64 }}>
                  <Stamp text="APPROVED" color={c.green} t={p(f, 212, 10)} rot={-10} size={38} />
                </div>
              )}
            </div>
          )}
          <div
            style={{
              marginTop: 30,
              fontFamily: font.display,
              fontWeight: 700,
              fontSize: 22,
              color: c.muted,
            }}
          >
            Audit log
          </div>
          <div
            style={{ ...mono, fontSize: 20, color: c.muted, marginTop: 8, whiteSpace: "pre-wrap" }}
          >
            <div>notes-bot proposed: delete note 42</div>
            {f >= 270 && (
              <div style={{ color: c.text, ...enter(p(f, 270, 12), 8) }}>
                you approved · notes-bot deleted note 42
              </div>
            )}
          </div>
        </div>
      </Win>
      <Cursor
        frame={f}
        path={[
          { f: 168, x: 1650, y: 840 },
          { f: 200, x: 1290, y: 440 },
        ]}
        clicks={[208]}
      />
    </AbsoluteFill>
  );
};
