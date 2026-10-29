// Shared by live capture, replay, and keyboard warmup. Importing owns no process.
// Keep one lease for the entire Windows desktop, not one per adapter module.
export const desktopLease = { active: false };
