// Thin layer over the Tauri runtime; everything degrades gracefully in a plain browser.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** A file the OS asked us to open (double-click on an .epub with the file association). */
export async function openedFile(): Promise<{ name: string; bytes: Uint8Array } | null> {
  if (!isTauri) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  const name = await invoke<string | null>('opened_file_name');
  if (!name) return null;
  const buf = await invoke<ArrayBuffer>('opened_file_bytes');
  return { name, bytes: new Uint8Array(buf) };
}

export async function toggleFullscreen() {
  if (isTauri) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const w = getCurrentWindow();
    await w.setFullscreen(!(await w.isFullscreen()));
    return;
  }
  if (document.fullscreenElement) await document.exitFullscreen();
  else await document.documentElement.requestFullscreen();
}

/** Opens a web page in the system browser. */
export async function openExternal(url: string) {
  if (isTauri) {
    const { openUrl } = await import('@tauri-apps/plugin-opener');
    await openUrl(url);
    return;
  }
  window.open(url, '_blank', 'noopener');
}
