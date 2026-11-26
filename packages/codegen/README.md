# @kitsuden/codegen

Frontend code generation for Kitsuden collections (datasets and native tables):
typed hooks, components, forms and types for React, Vue and Svelte. It is the
engine behind `kitsuden gen-types` in [`@kitsuden/cli`](https://www.npmjs.com/package/@kitsuden/cli),
and it has no runtime dependencies.

```bash
npm install @kitsuden/codegen@beta
```

```ts
import { generateReact, type CollectionInfo } from "@kitsuden/codegen";

const collection: CollectionInfo = {
  slug: "posts",
  name: "Posts",
  kind: "dataset",
  primaryKey: "id",
  columns: [
    { name: "id", type: "uuid", required: true, isPrimaryKey: true },
    { name: "title", type: "text", required: true },
  ],
};

for (const file of generateReact({ collection, framework: "react", type: "all" })) {
  console.log(file.filename); // write file.content wherever you keep generated code
}
```

Entry points: `@kitsuden/codegen` (everything), `@kitsuden/codegen/react`,
`@kitsuden/codegen/vue`, `@kitsuden/codegen/svelte` and
`@kitsuden/codegen/generators/types`. ESM and CommonJS, with types.

Part of [Kitsuden](https://github.com/Kitsuden/kitsuden). MIT.
