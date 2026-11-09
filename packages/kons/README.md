# packages/kons — installed kons

Kons are not part of the Kitsuden core. They live in the
[kitsuden-kons](https://github.com/Kitsuden/kitsuden-kons) repository
(or any repository with the same layout) and are **installed** here:

```bash
kitsuden kon add blog        # copies kons/kon-blog → packages/kons/kon-blog, pnpm install, migrations
kitsuden kon list
kitsuden kon remove blog
```

What is installed is declared in `kitsuden.kons.json` at the project root, which
is what the API reads (plus `KITSUDEN_KONS` in the environment). A folder here
that is not declared there is **not** loaded. The copies are git-ignored in the
Kitsuden repository: edit a kon in its own repository and reinstall it
(`kitsuden kon add <kon>` refuses to overwrite local changes unless `--force`).

See `docs/kons/README.md`.
