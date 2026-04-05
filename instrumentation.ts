export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { ensureStorageJanitorStarted } = await import("./lib/storageJanitor");
  ensureStorageJanitorStarted();
}
