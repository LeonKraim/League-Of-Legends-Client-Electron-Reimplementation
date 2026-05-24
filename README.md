# League Electron Client

Small Electron shell that discovers the currently running League Client UX process,
extracts the live `--app-port` and `--remoting-auth-token`, and starts a local
bridge that serves League frontend assets from the installed plugin WADs while
proxying API/websocket traffic to the authenticated League server.

## Commands

```powershell
npm start
npm run check:league
```

`npm run check:league` verifies the live League server with the current token.
On this run, `/plugin-manager/v1/status` returned `{"state":"PluginsInitialized"}`.

## Current Finding

The running League CEF log says Riot's own client navigates to:

```text
https://riot:<remoting-token>@127.0.0.1:<app-port>/bootstrap.html
```

That CEF navigation is intercepted by Pengu Loader. Direct external requests
from `curl`, Node HTTPS, and Electron receive:

```json
{"errorCode":"RESOURCE_NOT_FOUND","httpStatus":404,"message":"Invalid function"}
```

The Electron app works around this by generating the same bootstrap document,
extracting `/fe/...` frontend bundles from the local WADs on demand, and proxying
the WAMP websocket through `ws://127.0.0.1:<bridge>/ws` to Riot's local `wss://`
server with the live remoting token.

Verified screenshot: `league-electron-screenshot.png`.
