# Academic Translator

A local-first academic PDF reader for explicit English-to-Simplified-Chinese
translation selections.

## Development

Use Node 26 and pnpm 11.19.0. After installing dependencies, start the desktop
shell with:

```bash
pnpm tauri dev
```

The WebView only owns presentation and interaction. Trusted Rust code will own
filesystem access, credentials, provider calls, and translation processing.
