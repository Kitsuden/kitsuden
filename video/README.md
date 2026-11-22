# Landing page film and social image

Remotion source for two files in `site/`:

- `site/media/tutorial.mp4` (+ `tutorial.jpg`, `tutorial.vtt`): the 71-second tutorial in six
  steps that the landing page plays in its "Learn it in six steps" section.
- `site/og.png`: the 1200×630 social card for the landing page.
- `assets/social-preview.png`: the 1280×640 repository social preview. GitHub has no API for
  it: upload it by hand in Settings → General → Social preview.

Chapter timings and captions live in **`site/media/tutorial-chapters.json`**. The film reads it
at render time and the page reads it in the browser, so the step list, the progress bar, step
mode and the captions always match the film. Change a beat or a duration there, then render
again.

```bash
cd video
npm install
npm run studio     # scrub the timeline at http://localhost:3000
npm run render     # captions, film (1080p, downscaled to 720p with ffmpeg) and og.png
```

`render` needs `ffmpeg` on the PATH. This folder is not part of the pnpm workspace and is not
deployed: GitHub Pages only publishes `site/`.
