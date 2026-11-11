#!/usr/bin/env node
/**
 * Writes assets/readme/approval-flow.svg: the animated picture at the top of the
 * README (an agent asks to delete, Kitsuden holds it, a person approves, it runs once).
 *
 * It is an SVG with CSS keyframes and no script, because that is what GitHub renders
 * inside a README. Readers who ask for reduced motion get the last frame, still.
 *
 *   node scripts/readme-flow.mjs
 */
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const out = join(resolve(import.meta.dirname, ".."), "assets", "readme", "approval-flow.svg");

const C = {
  ink: "#0f1520",
  panel: "#161e2c",
  line: "#2a3446",
  text: "#f1f5f9",
  dim: "#a8b3c4",
  agent: "#7ab4ff",
  ok: "#34d399",
  wait: "#fbbf24",
  seal: "#ff5a36",
};
const LOOP = 16; // seconds
const END = 96; // % of the loop where everything fades for the restart

const frames = [];
let n = 0;
/** An element visible from `from`% to `to`% of the loop. `still` is what reduced motion shows. */
function show(from, to = END, { still = to >= END, land = false } = {}) {
  const name = `k${n++}`;
  const before = Math.max(from - 0.01, 0);
  const hidden = land ? "opacity:0;transform:scale(1.9)" : "opacity:0";
  const shown = land ? "opacity:1;transform:scale(1)" : "opacity:1";
  const settle = land
    ? `${(from + 1.4).toFixed(2)}%{opacity:1;transform:scale(.95)}${(from + 2.4).toFixed(2)}%,`
    : `${from}%,`;
  frames.push(
    `@keyframes ${name}{0%,${before}%{${hidden}}${land ? `${from}%{${hidden}}` : ""}${settle}${to}%{${shown}}${Math.min(to + 1.5, 100)}%,100%{opacity:0}}`
  );
  const box = land ? "transform-box:fill-box;transform-origin:center;" : "";
  return `style="${box}opacity:${still ? 1 : 0};animation:${name} ${LOOP}s linear infinite"`;
}

const sans = `class="s"`;
const mono = `class="m"`;
const check = (y, label, at, note, { waitFrom, okFrom } = {}) => {
  const row = (color, mark, text, attr) =>
    `<g ${attr}><rect x="440" y="${y}" width="328" height="46" rx="9" fill="${C.panel}" stroke="${color}" stroke-width="2"/>` +
    `<text ${mono} x="458" y="${y + 29}" font-size="18" font-weight="700" fill="${color}">${mark}</text>` +
    `<text ${sans} x="486" y="${y + 20}" font-size="15" font-weight="600" fill="${C.text}">${label}</text>` +
    `<text ${sans} x="486" y="${y + 38}" font-size="13" fill="${C.dim}">${text}</text></g>`;
  const idle =
    `<rect x="440" y="${y}" width="328" height="46" rx="9" fill="none" stroke="${C.line}" stroke-width="2"/>` +
    `<text ${sans} x="486" y="${y + 28}" font-size="15" font-weight="600" fill="${C.dim}">${label}</text>`;
  if (waitFrom !== undefined)
    return (
      idle +
      row(C.wait, "…", "a delete waits for a person", show(waitFrom, okFrom, { still: false })) +
      row(C.ok, "✓", "approved by you", show(okFrom))
    );
  return idle + row(C.ok, "✓", note, show(at));
};
const stamp = (x, y, w, text, color, rotate, attr) =>
  `<g transform="rotate(${rotate} ${x} ${y})"><g ${attr}>` +
  `<rect x="${x - w / 2}" y="${y - 21}" width="${w}" height="42" rx="8" fill="${C.ink}" stroke="${color}" stroke-width="4"/>` +
  `<text ${mono} x="${x}" y="${y + 8}" font-size="21" font-weight="800" letter-spacing="2" fill="${color}" text-anchor="middle">${text}</text>` +
  `</g></g>`;

const body = [
  `<rect x="1" y="1" width="1198" height="458" rx="28" fill="${C.ink}" stroke="${C.line}" stroke-width="2"/>`,
  `<line x1="416" y1="34" x2="416" y2="388" stroke="${C.line}" stroke-width="2"/>`,
  `<line x1="792" y1="34" x2="792" y2="388" stroke="${C.line}" stroke-width="2"/>`,
  `<line x1="56" y1="404" x2="1144" y2="404" stroke="${C.line}" stroke-width="2"/>`,

  // lane titles
  `<circle cx="62" cy="60" r="6" fill="${C.agent}"/><text ${sans} x="78" y="66" font-size="18" font-weight="700" fill="${C.text}">Your agent</text>`,
  `<circle cx="446" cy="60" r="6" fill="${C.text}"/><text ${sans} x="462" y="66" font-size="18" font-weight="700" fill="${C.text}">Kitsuden</text>`,
  `<circle cx="822" cy="60" r="6" fill="${C.seal}"/><text ${sans} x="838" y="66" font-size="18" font-weight="700" fill="${C.text}">You</text>`,

  // the agent
  `<g ${show(2)}><text ${mono} x="56" y="112" font-size="17" fill="${C.agent}">DELETE /api/notes/notes/42</text></g>`,
  `<g ${show(5)}><text ${mono} x="56" y="138" font-size="14" fill="${C.dim}">Bearer kitsuden_agent_7f3a…</text></g>`,
  `<g ${show(33, 66, { still: false })}><rect x="56" y="166" width="3" height="56" fill="${C.wait}"/>` +
    `<text ${mono} x="72" y="184" font-size="15" fill="${C.text}">202 pending approval</text>` +
    `<text ${mono} x="72" y="208" font-size="14" fill="${C.dim}">stored as a proposal, not run</text></g>`,
  `<g ${show(70)}><rect x="56" y="166" width="3" height="56" fill="${C.ok}"/>` +
    `<text ${mono} x="72" y="184" font-size="15" fill="${C.text}">200 executed</text>` +
    `<text ${mono} x="72" y="208" font-size="14" fill="${C.dim}">ran once, as notes-bot</text></g>`,

  // Kitsuden's checks
  check(92, "Key", 11, "notes-bot, active"),
  check(148, "Scope", 16, "has note:write"),
  check(204, "Row security", 21, "note 42 is its owner's"),
  check(260, "Sign-off", 0, "", { waitFrom: 26, okFrom: 66 }),
  stamp(604, 350, 196, "202 WAITING", C.wait, -5, show(30, 66, { still: false, land: true })),
  stamp(604, 350, 132, "200 OK", C.ok, -5, show(68, END, { land: true })),

  // you
  `<g ${show(0, 36, { still: false })}><rect x="816" y="92" width="328" height="46" rx="9" fill="none" stroke="${C.line}" stroke-width="2" stroke-dasharray="6 6"/>` +
    `<text ${sans} x="834" y="121" font-size="15" fill="${C.dim}">Nothing is waiting for you.</text></g>`,
  `<g ${show(38)}><rect x="816" y="92" width="328" height="178" rx="12" fill="${C.panel}" stroke="${C.wait}" stroke-width="2"/>` +
    `<text ${sans} x="836" y="124" font-size="16" fill="${C.text}"><tspan font-weight="700">notes-bot</tspan> wants to delete a note.</text>` +
    `<rect x="836" y="140" width="288" height="34" rx="7" fill="#3a2230"/>` +
    `<text ${mono} x="850" y="162" font-size="14" fill="${C.text}">− 42 · Old draft</text>` +
    `<rect x="836" y="194" width="138" height="52" rx="9" fill="${C.seal}"/>` +
    `<text ${sans} x="905" y="226" font-size="16" font-weight="700" fill="${C.ink}" text-anchor="middle">Approve</text>` +
    `<rect x="986" y="194" width="138" height="52" rx="9" fill="none" stroke="${C.line}" stroke-width="2"/>` +
    `<text ${sans} x="1055" y="226" font-size="16" font-weight="700" fill="${C.text}" text-anchor="middle">Reject</text></g>`,
  // the press on Approve, then the seal
  `<g ${show(55, 59, { still: false })}><rect x="832" y="190" width="146" height="60" rx="12" fill="none" stroke="${C.text}" stroke-width="3"/></g>`,
  stamp(1040, 214, 150, "APPROVED", C.seal, -8, show(60, END, { land: true })),
  `<g ${show(70)}><text ${sans} x="816" y="312" font-size="14" font-weight="700" fill="${C.text}">Audit log</text>` +
    `<text ${mono} x="816" y="336" font-size="13" fill="${C.dim}">you approved · notes-bot</text>` +
    `<text ${mono} x="816" y="356" font-size="13" fill="${C.dim}">deleted note 42</text></g>`,

  // what is happening, in words
  `<g ${show(1, 25, { still: false })}><text ${sans} x="56" y="438" font-size="19" fill="${C.text}">An agent asks to delete a note, with its own key.</text></g>`,
  `<g ${show(27, 58, { still: false })}><text ${sans} x="56" y="438" font-size="19" fill="${C.text}">With approvals on, Kitsuden does not run it: a delete waits for a person.</text></g>`,
  `<g ${show(60)}><text ${sans} x="56" y="438" font-size="19" fill="${C.text}">You approve. It runs once, and the decision is in the audit log.</text></g>`,
];

const desc =
  "Animation in three lanes. Your agent sends DELETE /api/notes/notes/42 with its own kitsuden_agent key. " +
  "Kitsuden checks the key, the scope and row security, and because approvals are on, the delete waits for a person: " +
  "the agent gets 202 pending approval and nothing runs. You see the proposal with what would be deleted, approve it, " +
  "and it runs once as the agent; the decision is written to the audit log.";

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 460" width="1200" height="460" role="img" aria-labelledby="t d">\n` +
  `<title id="t">How Kitsuden holds an agent's delete until a person approves it</title>\n` +
  `<desc id="d">${desc}</desc>\n` +
  `<style>.s{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif}` +
  `.m{font-family:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace}` +
  `${frames.join("")}@media (prefers-reduced-motion:reduce){*{animation:none!important}}</style>\n` +
  `${body.join("\n")}\n</svg>\n`;

writeFileSync(out, svg);
console.log(`${out}: ${svg.length} bytes, ${n} animated parts, ${LOOP}s loop`);
