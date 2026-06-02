# League Client Electron Reimplementation

<img width="800" height="450" alt="League client running in Electron" src="https://github.com/user-attachments/assets/d32c8063-e18b-49f8-b72c-2d95da9b60e7" />

A standalone Electron shell that wraps the League of Legends client. It discovers
the running `LeagueClientUx.exe` process, extracts the remoting credentials
(`--app-port`, `--remoting-auth-token`), and launches a local HTTP bridge that
serves frontend assets from the installed plugin WAD files while proxying HTTP
and WebSocket traffic to the authenticated LCU server.

## Creating Patches

Place `.patch.js` files in the `patches/` directory. See
[`patches/example-showcase.patch.js`](patches/example-showcase.patch.js) for
a documented example patch.

### Patch file format

```js
module.exports = {
  id: "my-patch",           // required: unique identifier
  description: "what it does", // optional
  enabled: true,        
  target: "asset",          // "html" | "asset" | omit for both
  match: {                  // optional
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

### Dumping FE assets for inspection

```bash
get_all_fe.bat
```

Extracts JS and CSS from installed WAD files into `fe_raw/` so you
can browse the source when writing patches.
