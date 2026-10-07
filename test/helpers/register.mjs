/** Register the TypeScript resolution hook before any test file loads. */
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./tsLoader.mjs", pathToFileURL(import.meta.filename).href);
