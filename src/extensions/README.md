# Web extensions (VSIX)

UCDVSC does not preinstall Vim. Install **web-compatible** extensions yourself.

## Install

Search in the Extensions view (Open VSX) and click **Install**. UCDVSC downloads the `.vsix` and loads it on the main thread. You should see “Installing… / Loaded” toasts.

If the gallery download fails:

1. Download a `.vsix` (e.g. [vscodevim](https://open-vsx.org/extension/vscodevim/vim) → `Download`)
2. Command Palette: `UCDVSC: Install Web Extension from VSIX…`
3. Pick the vsix; it is stored in IndexedDB and survives reload

## What works

| Type | Example | Works? |
|------|---------|--------|
| `"browser"` JS | vscodevim | Yes |
| Declarative (no `main`/`browser`) | color themes, icon themes, grammars, snippets | Yes |
| `"main"` only (Node) | clangd, official C/C++ | No |

After installing a theme: Command Palette → **Color Theme**.
