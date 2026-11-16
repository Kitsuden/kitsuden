/**
 * deepmerge 4.3.1 (MIT, James Halliday, Josh Duff and contributors), kept here with one
 * fix: GHSA-gcqx-w48m-w2h4 / CVE-2026-93753. A source object with an OWN `__proto__`
 * key (what `JSON.parse` produces) was written with `destination[key] = ...`, which
 * sets the prototype of the returned object. No release of deepmerge fixes it, and
 * `@sveltejs/vite-plugin-svelte` depends on it, so the root `pnpm.overrides` points
 * every `deepmerge` at this folder.
 *
 * Changes from upstream: `__proto__`, `constructor` and `prototype` keys are skipped,
 * values are written with `defineProperty` (never through a setter), and the default
 * `isMergeableObject` (the `is-mergeable-object` package) is inlined.
 */
"use strict";

const UNSAFE_KEYS = { __proto__: null, ["__proto__"]: true, constructor: true, prototype: true };

function isUnsafeKey(key) {
  return typeof key === "string" && UNSAFE_KEYS[key] === true;
}

const canUseSymbol = typeof Symbol === "function" && Symbol.for;
const REACT_ELEMENT_TYPE = canUseSymbol ? Symbol.for("react.element") : 0xeac7;

function defaultIsMergeableObject(value) {
  if (!value || typeof value !== "object") return false;
  const stringValue = Object.prototype.toString.call(value);
  return (
    stringValue !== "[object RegExp]" &&
    stringValue !== "[object Date]" &&
    value.$$typeof !== REACT_ELEMENT_TYPE
  );
}

function emptyTarget(val) {
  return Array.isArray(val) ? [] : {};
}

function cloneUnlessOtherwiseSpecified(value, options) {
  return options.clone !== false && options.isMergeableObject(value)
    ? deepmerge(emptyTarget(value), value, options)
    : value;
}

function defaultArrayMerge(target, source, options) {
  return target.concat(source).map(function (element) {
    return cloneUnlessOtherwiseSpecified(element, options);
  });
}

function getMergeFunction(key, options) {
  if (!options.customMerge) return deepmerge;
  const customMerge = options.customMerge(key);
  return typeof customMerge === "function" ? customMerge : deepmerge;
}

function getEnumerableOwnPropertySymbols(target) {
  return Object.getOwnPropertySymbols
    ? Object.getOwnPropertySymbols(target).filter(function (symbol) {
        return Object.propertyIsEnumerable.call(target, symbol);
      })
    : [];
}

function getKeys(target) {
  return Object.keys(target)
    .concat(getEnumerableOwnPropertySymbols(target))
    .filter(function (key) {
      return !isUnsafeKey(key);
    });
}

function propertyIsOnObject(object, property) {
  try {
    return property in object;
  } catch (_) {
    return false;
  }
}

// Protects from merging up the prototype chain (upstream's own check).
function propertyIsUnsafe(target, key) {
  return (
    propertyIsOnObject(target, key) &&
    !(Object.hasOwnProperty.call(target, key) && Object.propertyIsEnumerable.call(target, key))
  );
}

function define(object, key, value) {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function mergeObject(target, source, options) {
  const destination = {};
  if (options.isMergeableObject(target)) {
    getKeys(target).forEach(function (key) {
      define(destination, key, cloneUnlessOtherwiseSpecified(target[key], options));
    });
  }
  getKeys(source).forEach(function (key) {
    if (propertyIsUnsafe(target, key)) return;
    if (propertyIsOnObject(target, key) && options.isMergeableObject(source[key])) {
      define(destination, key, getMergeFunction(key, options)(target[key], source[key], options));
    } else {
      define(destination, key, cloneUnlessOtherwiseSpecified(source[key], options));
    }
  });
  return destination;
}

function deepmerge(target, source, options) {
  options = options || {};
  options.arrayMerge = options.arrayMerge || defaultArrayMerge;
  options.isMergeableObject = options.isMergeableObject || defaultIsMergeableObject;
  // cloneUnlessOtherwiseSpecified is added to `options` so that custom arrayMerge()
  // implementations can use it. The caller may not replace it.
  options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;

  const sourceIsArray = Array.isArray(source);
  const targetIsArray = Array.isArray(target);
  if (sourceIsArray !== targetIsArray) return cloneUnlessOtherwiseSpecified(source, options);
  if (sourceIsArray) return options.arrayMerge(target, source, options);
  return mergeObject(target, source, options);
}

deepmerge.all = function deepmergeAll(array, options) {
  if (!Array.isArray(array)) throw new Error("first argument should be an array");
  return array.reduce(function (prev, next) {
    return deepmerge(prev, next, options);
  }, {});
};

module.exports = deepmerge;
