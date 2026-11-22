import React from "react";
import { AbsoluteFill, Sequence, useCurrentFrame } from "remotion";
import { Intro, Outro } from "./scenes/IntroOutro";
import { AgentKey, Install, Model } from "./scenes/Steps123";
import { Approve, Checks, Connect } from "./scenes/Steps456";
import { ease, p } from "./theme";
import { Backdrop, Captions, chapter, Hud, Slate } from "./ui";

const SCENES: Record<string, React.FC> = {
  intro: Intro,
  install: Install,
  model: Model,
  key: AgentKey,
  connect: Connect,
  checks: Checks,
  approve: Approve,
  outro: Outro,
};

/** Each chapter fades out over its last frames, so cuts never pop. */
const Chapter: React.FC<{ id: string }> = ({ id }) => {
  const f = useCurrentFrame();
  const ch = chapter(id);
  const Scene = SCENES[id];
  const out = ch.n >= 1 && ch.n <= 6 ? p(f, ch.frames - 12, 12, ease.in) : 0;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - out }}>
        <Scene />
      </AbsoluteFill>
      {ch.n >= 1 && ch.n <= 6 && <Slate ch={ch} frame={f} />}
    </AbsoluteFill>
  );
};

export const Tutorial: React.FC = () => (
  <AbsoluteFill>
    <Backdrop />
    {Object.keys(SCENES).map((id) => {
      const ch = chapter(id);
      return (
        <Sequence
          key={id}
          from={ch.start}
          durationInFrames={ch.frames}
          name={`${ch.n} · ${ch.title}`}
        >
          <Chapter id={id} />
        </Sequence>
      );
    })}
    <Hud />
    <Captions />
  </AbsoluteFill>
);
