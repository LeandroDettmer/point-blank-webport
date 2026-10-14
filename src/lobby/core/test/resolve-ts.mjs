// Node resolve hook for the smokes that import the whole lobby controller: game/reportPopup.ts imports "../lockPointer" without
// an extension (vite resolves it, plain Node does not), so a relative import that fails is retried with ".ts".
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (e) {
    if (/^\.\.?\//.test(specifier) && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw e;
  }
}
