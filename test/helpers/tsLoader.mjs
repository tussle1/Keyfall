/**
 * Module resolution hook for running the TypeScript sources directly under
 * `node --test` (Node >= 22.18 strips types natively, but still requires
 * fully-specified ESM paths).
 *
 * The source tree uses extensionless relative imports, which is correct for a
 * bundler and for `tsc`, so this hook adds the missing `.ts` at resolve time.
 * Nothing is transformed here — Node does the type stripping itself.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  const { parentURL } = context;

  const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
  const alreadyHasExtension = /\.[a-z]+$/i.test(specifier);

  if (isRelative && !alreadyHasExtension && parentURL) {
    const parentPath = parentURL.startsWith("file:") ? fileURLToPath(parentURL) : parentURL;
    const base = dirname(parentPath);

    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      const full = resolvePath(base, candidate);
      if (existsSync(full)) {
        return { url: pathToFileURL(full).href, shortCircuit: true, format: "module-typescript" };
      }
    }
  }

  return nextResolve(specifier, context);
}
