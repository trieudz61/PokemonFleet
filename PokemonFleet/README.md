# PokemonFleet

Windows desktop app to manage 10+ jailbroken iPhones via USB. Built with Tauri 2 + Rust.

## Features

- Auto-discover iPhones via USB (libimobiledevice)
- Run / Stop Pokemon scripts on selected devices in parallel
- Per-device config editor (Pokemon_Config.txt)
- Excel-like data viewer for *.txt files (account lists, logs)
- Inline live log streaming via SSE
- One-click IDE access (opens browser at tunneled localhost:port)
- Bootstrap wizard for fresh devices (upload PokemonLoader.lue + show UDID)

## Architecture

```
PC (PokemonFleet.exe)
 ├─ Tauri WebView UI (vanilla JS)
 └─ Rust backend
     ├─ Device watcher (idevice_id polling)
     ├─ Tunnel pool (iproxy spawn per device)
     ├─ HTTP client → IOSControl REST API
     └─ SQLite local store
        ↓ USB cable ×N
        ↓ iproxy → usbmuxd → iPhone
        iPhone (port 9999, IOSControl tweak)
```

## Dev (macOS for now, Windows target)

```bash
# Install Rust + Tauri CLI (one-time)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
npm install -g @tauri-apps/cli@latest

# Mac: install libimobiledevice
brew install libimobiledevice libusbmuxd

# Run dev mode
cd PokemonFleet
npm install
npm run dev
```

## Production build (Windows)

Cross-compile from macOS not supported by Tauri — must build on Windows machine.

```powershell
# On Windows 10+
# 1. Install Rust + Node + Tauri prerequisites (Visual Studio Build Tools, WebView2)
# 2. Place libimobiledevice binaries in src-tauri/binaries/
# 3. Build
npm install
npm run build
```

Output: `src-tauri/target/release/bundle/msi/PokemonFleet_*.msi`

## License

Proprietary — distributed under PokemonFleet license. See https://pokemon.ioscontrol.com/fleet
