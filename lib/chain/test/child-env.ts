/**
 * Environment for a test subprocess. Next's type augmentation makes `NODE_ENV` a required key of
 * `NodeJS.ProcessEnv`, but a deliberately minimal child environment (PATH/HOME and the variable under
 * test) must not carry one, so the single cast lives here instead of at every `spawnSync` call.
 */
export function childEnv(
  vars: Record<string, string | undefined>
): NodeJS.ProcessEnv {
  return vars as unknown as NodeJS.ProcessEnv
}
