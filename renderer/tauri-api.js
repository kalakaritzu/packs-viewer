// Bridges the renderer to the Rust backend when running under Tauri (Electron's preload provides window.api otherwise).
(() => {
  if (window.api || !window.__TAURI__) return;
  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;
  window.api = {
    getRoot: () => invoke('get_root'),
    scan: (force) => invoke('scan', { force: !!force }),
    shapes: () => invoke('shapes'),
    onShapeProgress: (cb) => listen('shape-progress', (e) => cb(e.payload)),
    pickFolder: () => invoke('pick_folder'),
    readFile: async (p) => new Uint8Array(await invoke('read_file', { path: p })),
    dragStart: (p) => invoke('drag_start', { path: p }),
    closeWin: () => invoke('win_close'),
    pinWin: (on) => invoke('win_pin', { on }),
    minWin: () => invoke('win_min'),
    reveal: (p) => invoke('reveal', { path: p }),
    copyPath: (p) => invoke('copy_path', { path: p }),
    onProgress: (cb) => listen('scan-progress', (e) => cb(e.payload)),
  };
  // Frameless window: drag by the title bar, but not from its buttons.
  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !e.target.closest('#nav') || e.target.closest('button')) return;
    invoke('win_drag');
  });
})();
