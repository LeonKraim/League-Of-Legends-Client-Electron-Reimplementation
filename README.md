# League Client Electron Reimplementation

<img width="800" height="450" alt="League client running in Electron" src="https://github.com/user-attachments/assets/d32c8063-e18b-49f8-b72c-2d95da9b60e7" />

A standalone Electron shell that wraps the League of Legends client. It discovers
the running `LeagueClientUx.exe` process, extracts the remoting credentials
(`--app-port`, `--remoting-auth-token`), and launches a local HTTP bridge that
serves frontend assets from the installed plugin WAD files while proxying HTTP
and WebSocket (WAMP) traffic to the authenticated LCU server.

## Features

- **On-demand WAD extraction** — JavaScript, CSS, and images are extracted from
  `assets.wad` files at runtime via
  [@lol-archiver/lol-wad-extract](https://www.npmjs.com/package/@lol-archiver/lol-wad-extract).
- **LCU proxy** — HTTP API calls and WAMP WebSocket connections are proxied to
  the League client with transparent authentication.
- **Auto-launch** — Starts League of Legends if it isn't already running.
- **Frameless window** — Native-looking borderless window with custom drag
  regions matching the original League client chrome.
- **Zoom / resize** — Supports the three standard League window sizes (1024×576,
  1280×720, 1600×900) with correct `zoomFactor` scaling.
- **Patch system** — On-the-fly transforms applied to frontend assets. See
  [Creating Patches](#creating-patches) below.

## Setup

```bash
npm install
```

Edit `settings.json` if auto-detection fails:

```json
{
  "leagueClientDir": "C:\\Riot Games\\League of Legends",
  "riotClientDir": "C:\\Riot Games\\Riot Client"
}
```

Leave either field empty (`""`) to keep auto-detection.

## Running

```bash
npm start
```

Or double-click `start.bat`.

## Creating Patches

The patching system transforms frontend assets in memory — original WAD files
are **never** modified.

Place `.patch.js` files in the `patches/` directory. See
[`patches/example-showcase.patch.js`](patches/example-showcase.patch.js) for
a fully documented example covering every feature.

### Patch file format

```js
module.exports = {
  id: "my-patch",           // required: unique identifier
  description: "what it does", // optional
  enabled: true,            // set to false to disable
  target: "asset",          // "html" | "asset" | omit for both
  match: {                  // optional: AND-combined rules
    plugin: "rcp-fe-lol-uikit",
    ext: ".css"
  },
  transforms: [
    { type: "replace", find: "old", replace: "new", flags: "g" },
    { type: "regex", pattern: /pattern/, replace: "replacement" },
    { type: "prepend-once", marker: "/* marker */", content: "/* marker */\n" },
    { type: "append-once", marker: "<!-- end -->", content: "\n<!-- end -->" },
    { type: "inject-css", position: "before", content: ".class { color: red; }" },
    { type: "custom", fn: (content) => content.replace(/foo/g, "bar") }
  ]
};
```

### Running the tests

```bash
node scripts/test-patcher.js
```

This validates the patching engine (match rules, transforms, buffer handling,
HTML patching) with all currently installed patches.

### Dumping FE assets for inspection

```bash
get_all_fe.bat
```

Extracts JS and CSS from installed WAD files into `fe_raw/` (gitignored) so you
can browse the source when writing patches.

## Building

```bash
npm run build
```

Outputs a packaged Electron app to `dist/`.

## License

See [LICENSE](LICENSE).
