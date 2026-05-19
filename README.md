# PokemonFleet

End-to-end stack for the Pokemon iPhone-farm tooling.

```
.
├── PokemonFleet/      Tauri 2 desktop app for managing jailbroken iPhones
├── pokemon-worker/    Cloudflare Worker (license + script delivery API)
└── POKEMON_CONTEXT.md Architecture notes & design decisions
```

## Building the Windows installer

`.github/workflows/build-windows.yml` runs on `windows-latest`, bundles
`idevice_id.exe` + `iproxy.exe`, and emits MSI / NSIS installers. Trigger
manually from the Actions tab or push a tag like `v0.1.0` for a Release.

## Local dev

### PokemonFleet (desktop)
```bash
cd PokemonFleet
npm install
npm run dev
```

### pokemon-worker
```bash
cd pokemon-worker
npm install
npx wrangler dev
```
