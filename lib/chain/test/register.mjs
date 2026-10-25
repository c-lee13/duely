// Lets Node run the TypeScript sources directly (it strips types), by resolving extensionless
// relative imports ("./config") to their .ts files. Used by `npm run test:chain` and by the
// scripts under scripts/ (e.g. `npm run chain:integration`).
import { register } from "node:module"

register("./resolve-ts.mjs", import.meta.url)
