export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    for (const suffix of ["", ".ts", "/index.ts"]) {
      try {
        return await nextResolve(specifier + suffix, context)
      } catch (error) {
        if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.code !== "ERR_UNSUPPORTED_DIR_IMPORT") throw error
      }
    }
  }
  return nextResolve(specifier, context)
}
