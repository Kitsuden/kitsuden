// Writes site/media/tutorial.vtt from site/media/tutorial-chapters.json: the film's captions as a
// text track, so screen readers and muted viewers get the same words the film shows.
import { readFileSync, writeFileSync } from "node:fs";

const src = new URL("../../site/media/tutorial-chapters.json", import.meta.url);
const out = new URL("../../site/media/tutorial.vtt", import.meta.url);
const { fps, chapters } = JSON.parse(readFileSync(src, "utf8"));

const ts = (frame) => {
  const s = frame / fps;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = (s % 60).toFixed(3).padStart(6, "0");
  return `00:${mm}:${ss}`;
};

const cues = [];
for (const ch of chapters) {
  ch.beats.forEach((b, i) => {
    const from = ch.start + b.at;
    const to = ch.start + (i + 1 < ch.beats.length ? ch.beats[i + 1].at : ch.frames);
    const label = ch.n >= 1 && ch.n <= 6 ? `Step ${ch.n}, ${ch.title}. ` : "";
    cues.push(`${ts(from)} --> ${ts(to)}\n${i === 0 ? label : ""}${b.text}`);
  });
}
writeFileSync(out, `WEBVTT\n\n${cues.join("\n\n")}\n`);
console.log(`tutorial.vtt: ${cues.length} cues`);
