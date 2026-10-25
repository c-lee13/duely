/**
 * Optional pausable-token support. RLUSD is pausable (OpenZeppelin v5 `Pausable`): while paused,
 * transfers and approvals revert with `EnforcedPause()` (selector 0xd93c0665). MockUSDC has no
 * `paused()`, so every use of this ABI must tolerate the method being absent.
 */
export const tokenPauseAbi = [
  {
    type: "function",
    name: "paused",
    inputs: [],
    outputs: [{ name: "", type: "bool", internalType: "bool" }],
    stateMutability: "view",
  },
  { type: "error", name: "EnforcedPause", inputs: [] },
] as const
