// Writes site/media/tutorial.vtt (English) and tutorial.es.vtt (Spanish) from
// site/media/tutorial-chapters.json: the film's captions as text tracks, so screen readers and
// muted viewers get the same words the film shows.
import { readFileSync, writeFileSync } from "node:fs";

const src = new URL("../../site/media/tutorial-chapters.json", import.meta.url);
const { fps, chapters } = JSON.parse(readFileSync(src, "utf8"));

const ts = (frame) => {
  const s = frame / fps;
  const mm = String(Math.floor(s / 60)).padStart(2, "0");
  const ss = (s % 60).toFixed(3).padStart(6, "0");
  return `00:${mm}:${ss}`;
};

const LANGS = {
  en: { file: "tutorial.vtt", step: "Step", text: "text", title: "title" },
  es: { file: "tutorial.es.vtt", step: "Paso", text: "text_es", title: "title_es" },
};

for (const [lang, l] of Object.entries(LANGS)) {
  const cues = [];
  for (const ch of chapters) {
    ch.beats.forEach((b, i) => {
      const from = ch.start + b.at;
      const to = ch.start + (i + 1 < ch.beats.length ? ch.beats[i + 1].at : ch.frames);
      const label = ch.n >= 1 && ch.n <= 6 && i === 0 ? `${l.step} ${ch.n}, ${ch[l.title]}. ` : "";
      cues.push(`${ts(from)} --> ${ts(to)}\n${label}${b[l.text]}`);
    });
  }
  writeFileSync(
    new URL(`../../site/media/${l.file}`, import.meta.url),
    `WEBVTT\n\n${cues.join("\n\n")}\n`
  );
  console.log(`${l.file}: ${cues.length} cues (${lang})`);
}
