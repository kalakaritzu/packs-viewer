# Packs Viewer

A fast, clean desktop browser for FL Studio sample packs. Built with Tauri 2 (Rust + WebView2).

- Instant previews, typo-tolerant search, favorites, filters
- Search by shape: sketch a volume curve and find samples that look like it (WAV)
- Drag samples straight into FL Studio, always-on-top pin

## Build

```
npm install
npm run build        # release exe in src-tauri/target/release
npm run installer    # one-click setup exe in build/ (needs NSIS from a prior tauri build)
```
