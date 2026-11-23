import React from "react";
import { Composition, Still } from "remotion";
import { OgImage } from "./OgImage";
import { RepoPreview } from "./RepoPreview";
import { Tutorial } from "./Tutorial";
import { TOTAL } from "./ui";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Tutorial"
      component={Tutorial}
      durationInFrames={TOTAL}
      fps={30}
      width={1920}
      height={1080}
    />
    <Still id="OgImage" component={OgImage} width={1200} height={630} />
    <Still id="RepoPreview" component={RepoPreview} width={1280} height={640} />
  </>
);
