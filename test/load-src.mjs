import { registerHooks } from "node:module";

// The Worker sources import each other as `./x.js`, the spelling the
// bundler wants. Node finds no such file, so fall back to `./x.ts`, and
// say the .ts files are ES modules, since package.json does not.
registerHooks({
  resolve(specifier, context, nextResolve) {
    let resolved;
    try {
      resolved = nextResolve(specifier, context);
    } catch (e) {
      if (!specifier.startsWith(".") || !specifier.endsWith(".js")) throw e;
      resolved = nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    if (new URL(resolved.url).pathname.endsWith(".ts")) {
      return { ...resolved, format: "module-typescript" };
    }
    return resolved;
  },
});

let isolate = 0;

/** Import `src/<name>.ts` as a new module instance, with its own
 *  module-scope state, the way a new Workers isolate would see it. */
export function loadSrc(name) {
  isolate += 1;
  return import(new URL(`../src/${name}.ts?isolate=${isolate}`, import.meta.url).href);
}
