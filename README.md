# League Electron Client

A frameless Electron shell that wraps the League of Legends client. It discovers the running `LeagueClientUx.exe` process, extracts the live remoting credentials (`--app-port`, `--remoting-auth-token`), and starts a local bridge that serves frontend assets from the installed plugin WADs while proxying HTTP and WebSocket traffic to the authenticated LCU server.

## Features

- **No Riot CEF** – replaces the stock Chromium Embedded Framework with a modern Electron window
- **Custom window chrome** – frameless, draggable, with configurable sizes (1024×576, 1280×720, 1600×900)
- **Asset extraction** – on-the-fly extraction of JS/CSS/images from `assets.wad` files via `@lol-archiver/lol-wad-extract`
- **Full LCU proxy** – forwards API calls and WAMP WebSocket connections to the League client
- **Auto-launch** – starts League if not running, suppresses the stock UX window and Riot Client splash

## Prerequisites

- [Node.js](https://nodejs.org/) 18+
- League of Legends installed (detected in common directories or configured manually)

## Setup

```powershell
git clone <repo>
cd league-electron-client
npm install
```

## Usage

```powershell
npm start
```

To verify the live League client is reachable:

```powershell
npm run check:league
```

## Configuration

Edit `settings.json` to manually specify League/Riot install directories (leave empty for auto-detection):

```json
{
  "leagueClientDir": "C:\\Riot Games\\League of Legends",
  "riotClientDir": "C:\\Riot Games\\Riot Client"
}
```

## Debugging

Set `DEBUG_LEAGUE_ELECTRON=1` for verbose logging, screenshots, and state dumps:

```powershell
$env:DEBUG_LEAGUE_ELECTRON=1; npm start
```

Press `F12` to toggle DevTools.
