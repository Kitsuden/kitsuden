/**
 * Agent prompt templates
 * ============================================================================
 *
 * `renderPromptTemplate` resolves `{{event.field}}` by walking an object that
 * comes from a request body or an event. The previous version did it
 * with `reduce((obj: any, key) => obj?.[key], data)`.
 *
 * That `any` did not hide a runtime failure —here it is only read and converted
 * to text— but it did hide a READ one: `object["__proto__"]` does not return
 * `undefined`, it returns `Object.prototype`. A template could traverse the
 * prototype chain and end up printing engine internals inside
 * a prompt sent to a model.
 *
 * `kon-formulas` already cut these keys; here it did not. Now it does, with the same list.
 */

import { describe, expect, it } from "vitest";

import {
  UNTRUSTED_DATA_NOTICE,
  renderPromptTemplate,
} from "../../apps/api/src/lib/actions/handlers/agent-handler";

// Event values are fenced as untrusted data (security review 2026-11-04).
const fenced = (text: string) =>
  `${UNTRUSTED_DATA_NOTICE}

${text.replace(/«([^»]*)»/g, "<untrusted-content>$1</untrusted-content>")}`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal ActionContext double
const ctx = (data: unknown): any => ({ event: { data } });

describe("renderPromptTemplate", () => {
  it("resolves a normal path", () => {
    expect(renderPromptTemplate("Hello {{name}}", ctx({ name: "Ana" }))).toBe(
      fenced("Hello «Ana»")
    );
  });

  it("resolves nested paths", () => {
    expect(
      renderPromptTemplate(
        "{{order.customer.email}}",
        ctx({ order: { customer: { email: "a@b.c" } } })
      )
    ).toBe(fenced("«a@b.c»"));
  });

  it("a path that does not exist stays empty, it does not print 'undefined'", () => {
    expect(renderPromptTemplate("[{{does.not.exist}}]", ctx({}))).toBe("[]");
  });

  it("does not traverse __proto__", () => {
    // Before, this returned Object.prototype and then converted it to text.
    expect(renderPromptTemplate("[{{__proto__}}]", ctx({}))).toBe("[]");
    expect(renderPromptTemplate("[{{__proto__.constructor}}]", ctx({}))).toBe("[]");
  });

  it("does not traverse constructor or prototype", () => {
    expect(renderPromptTemplate("[{{constructor}}]", ctx({}))).toBe("[]");
    expect(renderPromptTemplate("[{{constructor.name}}]", ctx({}))).toBe("[]");
    expect(renderPromptTemplate("[{{prototype}}]", ctx({}))).toBe("[]");
  });

  it("only reads OWN properties, not inherited ones", () => {
    // Inheriting a property is not having it: `toString` exists in the chain of
    // every object and is not event data.
    expect(renderPromptTemplate("[{{toString}}]", ctx({}))).toBe("[]");
  });

  it("does not break if the intermediate value is not an object", () => {
    expect(renderPromptTemplate("[{{a.b.c}}]", ctx({ a: "text" }))).toBe("[]");
    expect(renderPromptTemplate("[{{a.b}}]", ctx({ a: null }))).toBe("[]");
  });
});
