const { app, BrowserWindow, Menu, ipcMain, session, shell } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const WebSocket = require('ws');
const { extractWAD } = require('@lol-archiver/lol-wad-extract');

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';

const DEBUG = process.env.DEBUG_LEAGUE_ELECTRON === '1';
const LEAGUE_UA = 'Mozilla/5.0 LeagueOfLegendsClient/16.10.777.2413 (CEF 108)';
const LEAGUE_DIR = 'C:\\Riot Games\\League of Legends';
const PLUGINS_DIR = path.join(LEAGUE_DIR, 'Plugins');
const FRONTEND_PREFIX = 'rcp-fe-';
const STATIC_PLUGIN = 'rcp-fe-lol-static-assets';
const WINDOW_SIZES = [
  { width: 1024, height: 576, scale: 0.8 },
  { width: 1280, height: 720, scale: 1 },
  { width: 1600, height: 900, scale: 1.25 }
];

process.on('uncaughtException', (error) => {
  console.error(`[main:uncaught] ${error.stack || error.message}`);
});

process.on('unhandledRejection', (error) => {
  console.error(`[main:unhandled] ${error && (error.stack || error.message) || error}`);
});

app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

ipcMain.handle('riot-invoke', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return undefined;
  return handleRiotInvoke(win, payload);
});

ipcMain.on('riot-invoke', (event, request) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  handleRiotInvoke(win, { request }).catch((error) => {
    console.error(`[riotInvoke] ${error.message}`);
  });
});

const windowDragState = new WeakMap();

ipcMain.on('league-window-drag-start', (event, point) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !point) return;

  windowDragState.set(win, {
    bounds: win.getBounds(),
    screenX: Number(point.screenX),
    screenY: Number(point.screenY)
  });
});

ipcMain.on('league-window-drag-move', (event, point) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const state = win && windowDragState.get(win);
  if (!win || !state || !point) return;

  const x = Math.round(state.bounds.x + Number(point.screenX) - state.screenX);
  const y = Math.round(state.bounds.y + Number(point.screenY) - state.screenY);
  win.setPosition(x, y, false);
});

ipcMain.on('league-window-drag-end', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win) windowDragState.delete(win);
});

function readLeagueUxArgs() {
  const ps = [
    '-NoProfile',
    '-Command',
    "(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'LeagueClientUx.exe' } | Select-Object -First 1 -ExpandProperty CommandLine)"
  ];
  const commandLine = execFileSync('powershell.exe', ps, { encoding: 'utf8' }).trim();
  if (!commandLine) {
    throw new Error('LeagueClientUx.exe is not running.');
  }

  const value = (name) => {
    const match = commandLine.match(new RegExp(`--${name}=([^"\\s]+|"[^"]+")`));
    return match ? match[1].replace(/^"|"$/g, '') : null;
  };

  const port = value('app-port');
  const token = value('remoting-auth-token');
  const riotPort = value('riotclient-app-port');
  const riotToken = value('riotclient-auth-token');

  if (!port || !token) {
    throw new Error('Could not find --app-port and --remoting-auth-token in LeagueClientUx.exe command line.');
  }

  return { port, token, riotPort, riotToken };
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function getPlugins() {
  const manifest = readJson(path.join(PLUGINS_DIR, 'plugin-manifest.json'));
  return manifest.plugins
    .map((plugin) => {
      const descriptionPath = path.join(PLUGINS_DIR, plugin.name, 'description.json');
      if (!fs.existsSync(descriptionPath)) return null;
      return { ...plugin, description: readJson(descriptionPath) };
    })
    .filter(Boolean);
}

function frontendPlugins() {
  return getPlugins().filter(({ name, description }) => (
    name.startsWith(FRONTEND_PREFIX) &&
    description.riotMeta &&
    description.riotMeta.type === 'frontend' &&
    description.riotMeta.hasBundledAssets
  ));
}

function buildDependencyGraph(plugins) {
  const dependencies = {};
  const implementations = {};
  const lazy = [];
  const shims = {};

  for (const plugin of plugins) {
    dependencies[plugin.name] = plugin.description.pluginDependencies || [];
    if (plugin.lazy) lazy.push(plugin.name);
    for (const contractName of plugin.as || []) {
      implementations[contractName] = plugin.name;
    }
  }

  return {
    dependencies,
    implementations,
    lazy,
    sequence: plugins.map((plugin) => plugin.name),
    shims
  };
}

function urlSegmentForPlugin(pluginName) {
  return pluginName.startsWith(FRONTEND_PREFIX)
    ? pluginName.slice(FRONTEND_PREFIX.length)
    : pluginName;
}

function buildIndexHtml(league, bridgePort) {
  const plugins = frontendPlugins();
  const cssLinks = [];
  const scriptTags = [];
  const timestamp = Date.now();

  for (const plugin of plugins) {
    if (plugin.name === 'rcp-fe-plugin-runner') continue;
    const segment = urlSegmentForPlugin(plugin.name);
    const cssName = plugin.name === 'rcp-fe-lol-uikit' ? 'main.css' : `${plugin.name}.css`;
    const wadPath = path.join(PLUGINS_DIR, plugin.name, 'assets.wad');
    cssLinks.push({ plugin, href: `/fe/${segment}/${cssName}`, wadPath, fileInpack: `plugins/${plugin.name}/global/default/${cssName}` });
    scriptTags.push(`<script src='/fe/${segment}/${plugin.name}.js?t=${timestamp}'></script>`);
  }

  const cssHtml = cssLinks
    .map(({ plugin, href }) => plugin.name === 'rcp-fe-lol-uikit'
      ? `<link rel='stylesheet' href='${href}'>`
      : `<link href='${href}' rel='stylesheet' data-plugin-name='${plugin.name}'>`)
    .join('');

  return `<!doctype html><html><head>  <base href='/'>  <meta charset='utf-8'>  <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0' />  <link rel='riot:plugins:dependency-graph' href='/graph.json' />  <link rel='riot:plugins:websocket' href='ws://127.0.0.1:${bridgePort}/ws' />  ${cssHtml}  <style>${electronDragCss()}</style>  <script>${electronDragScript()}</script>  <script>window.getPluginAnnounceEventName = (pluginName) => \`riotPlugin.announce:\${pluginName}\`;</script>${scriptTags.join('')}</head><body data-env='public' data-loading-div-id='index_loading_div_20210908'>  <div id='index_loading_div_20210908' style='position: fixed;display: flex;align-items: center;justify-content: center;flex-direction: column;pointer-events: all;top: 0;left: 0;width: 100%;height: 100%;direction: ltr;'>    <img src='/lol-game-data/assets/ASSETS/SplashScreens/lol_icon.png'>  </div>  <script src='/fe/plugin-runner/rcp-fe-plugin-runner.js?t=${timestamp}'></script></body></html>`;
}

function currentWindowScale(win) {
  if (win.currentLeagueWindowSize) return win.currentLeagueWindowSize.scale;
  const [width, height] = win.getContentSize();
  const match = WINDOW_SIZES.find((size) => size.width === width && size.height === height);
  return match ? match.scale : 1;
}

function windowSizeForScale(scale) {
  const numericScale = Number(scale);
  return WINDOW_SIZES.find((size) => Math.abs(size.scale - numericScale) < 0.001) || WINDOW_SIZES[1];
}

function windowSizeForDimensions(width, height) {
  return WINDOW_SIZES.find((size) => size.width === width && size.height === height) || WINDOW_SIZES[1];
}

function riotResult(value) {
  return JSON.stringify({ result: JSON.stringify(value) });
}

function applyWindowSize(win, size, center = false) {
  win.setResizable(true);
  win.setMinimumSize(0, 0);
  win.setMaximumSize(9999, 9999);
  win.webContents.setZoomFactor(size.scale);
  win.setContentSize(size.width, size.height);
  win.currentLeagueWindowSize = size;
  win.webContents.executeJavaScript(
    `if (window.__setLeagueElectronSize) {
      window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale});
      setTimeout(() => window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale}), 50);
      setTimeout(() => window.__setLeagueElectronSize(${size.width}, ${size.height}, ${size.scale}), 250);
    }`,
    true
  ).catch(() => {});
  win.setResizable(false);
  if (center) win.center();
}

async function applySavedWindowSize(win, league) {
  const responses = await Promise.all([
    requestLeague('/lol-settings/v1/local/video', league.port, league.token),
    requestLeague('/lol-settings/v2/local/LCUPreferences/video', league.port, league.token)
  ]);
  const response = responses.find((candidate) => candidate.statusCode && candidate.statusCode < 400 && candidate.body) || responses[0];
  const parsed = parseJsonBody(Buffer.from(response.body || ''));
  const scale = parsed && (parsed.ZoomScale ?? parsed.data?.ZoomScale);
  if (scale !== undefined) applyWindowSize(win, windowSizeForScale(scale), true);
}

function electronDragCss() {
  return `
    body,
    body *,
    button,
    input,
    select,
    textarea,
    a,
    [role='button'],
    [tabindex],
    [onclick] {
      -webkit-app-region: no-drag;
    }

    body,
    body *:not(input):not(textarea) {
      -webkit-user-drag: none;
      -webkit-user-select: none;
      user-select: none;
    }

    img,
    svg,
    canvas,
    video {
      -webkit-user-drag: none;
      user-drag: none;
    }

    html,
    body {
      background: #010a13 !important;
      height: 100% !important;
      margin: 0 !important;
      overflow: hidden !important;
      transform: none !important;
      width: 100% !important;
    }

    input,
    textarea {
      user-select: text;
    }

    rcp-fe-lol-navigation,
    lol-uikit-navigation,
    lol-navigation,
    .rcp-fe-lol-navigation,
    .lol-navigation,
    .navigation,
    .navigation-bar,
    .nav-bar,
    .top-nav,
    .topbar,
    .titlebar,
    .title-bar,
    .window-chrome,
    .chrome,
    header {
      -webkit-app-region: no-drag;
    }

    [data-electron-no-drag],
    [data-electron-no-drag] *,
    .app-controls,
    .app-controls *,
    .app-controls-button,
    .app-controls-button *,
    .app-controls-support,
    .app-controls-hide,
    .app-controls-settings,
    .app-controls-close,
    .summoner,
    .summoner *,
    .currency,
    .currency *,
    .social,
    .social *,
    .parties,
    .parties *,
    .navigation-item,
    .navigation-item *,
    .nav-item,
    .nav-item *,
    .nav-button,
    .nav-button * {
      -webkit-app-region: no-drag;
    }
  `.replace(/\s+/g, ' ').trim();
}

function electronDragScript() {
  return `
    (() => {
      window.alert = () => {};
      window.confirm = () => false;
      window.onerror = () => true;
      window.onunhandledrejection = (event) => {
        event.preventDefault();
        return true;
      };
      window.addEventListener('error', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      window.addEventListener('unhandledrejection', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      }, true);
      document.addEventListener('dragstart', (event) => {
        event.preventDefault();
      }, true);
      document.addEventListener('selectstart', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
        event.preventDefault();
      }, true);
      window.__setLeagueElectronSize = (width, height) => {
        if (!document.body) return;
        document.documentElement.style.setProperty('width', '100%', 'important');
        document.documentElement.style.setProperty('height', '100%', 'important');
        document.documentElement.style.setProperty('overflow', 'hidden', 'important');
        document.body.style.setProperty('width', '100%', 'important');
        document.body.style.setProperty('height', '100%', 'important');
        document.body.style.setProperty('transform', 'none', 'important');
        document.body.style.setProperty('transform-origin', 'top left', 'important');
        document.body.style.setProperty('overflow', 'hidden', 'important');
        window.dispatchEvent(new Event('resize'));
      };
      const allElements = (root = document) => {
        const result = [];
        const visit = (node) => {
          if (!node) return;
          if (node.nodeType === Node.ELEMENT_NODE) {
            result.push(node);
            if (node.shadowRoot) visit(node.shadowRoot);
          }
          for (const child of node.children || []) visit(child);
        };
        visit(root);
        return result;
      };
      const hideOpenPartyTooltip = () => {
        const textMatches = [];
        for (const element of allElements()) {
          const text = (element.textContent || '').replace(/\\s+/g, ' ').trim().toUpperCase();
          if (/PARTY\\s+IS\\s+OPEN/.test(text) || /YOUR\\s+PARTY/.test(text)) textMatches.push(element);
        }

        for (const element of textMatches.reverse()) {
          let node = element;
          for (let i = 0; i < 10 && node && node !== document.body && node !== document.documentElement; i += 1) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            if (
              rect.width >= 120 &&
              rect.width <= 560 &&
              rect.height >= 40 &&
              rect.height <= 260 &&
              style.position !== 'static'
            ) {
              node.style.display = 'none';
              node.dataset.electronHiddenOpenPartyTooltip = 'true';
              break;
            }
            node = node.parentElement || node.host;
          }
        }
      };
      if (document.body) window.__setLeagueElectronSize(window.innerWidth, window.innerHeight);
      const dragSelectors = [
        'rcp-fe-lol-navigation',
        'lol-uikit-navigation',
        'lol-navigation',
        '.rcp-fe-lol-navigation',
        '.lol-navigation',
        '.navigation-bar',
        '.nav-bar',
        '.top-nav',
        '.topbar',
        '.titlebar',
        '.title-bar',
        '.window-chrome'
      ];
      const interactiveSelectors = [
        'button',
        'a',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[tabindex]',
        '[onclick]',
        '[action]',
        '.app-controls',
        '.app-controls-button',
        '.app-controls-support',
        '.app-controls-hide',
        '.app-controls-settings',
        '.app-controls-close',
        '.summoner',
        '.currency',
        '.social',
        '.parties',
        '.navigation-item',
        '.nav-item',
        '.nav-button'
      ];
      const parentOf = (node) => node && (node.parentElement || (node.getRootNode && node.getRootNode().host));
      const interactiveSelector = interactiveSelectors.join(',');
      const isInteractiveTarget = (target) => {
        let node = target;
        for (let i = 0; i < 12 && node && node !== document.body && node !== document.documentElement; i += 1) {
          if (node.nodeType !== Node.ELEMENT_NODE) {
            node = parentOf(node);
            continue;
          }
          if (node.dataset && node.dataset.electronNoDrag === 'true') return true;
          if (node.matches && node.matches(interactiveSelector)) return true;
          const style = getComputedStyle(node);
          if (style.cursor === 'pointer') return true;
          node = parentOf(node);
        }
        return false;
      };
      const canStartWindowDrag = (clientX, clientY, target) => {
        if (clientY < 0 || clientY > 45) return false;
        if (clientX < 0 || clientX > window.innerWidth - 420) return false;
        if (isInteractiveTarget(target)) return false;
        return true;
      };
      window.__leagueElectronCanDragPoint = (clientX, clientY) => {
        return canStartWindowDrag(clientX, clientY, document.elementFromPoint(clientX, clientY));
      };
      let draggingWindow = false;
      let activePointerId = null;
      const endWindowDrag = () => {
        if (!draggingWindow) return;
        draggingWindow = false;
        activePointerId = null;
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.end();
      };
      document.addEventListener('pointerdown', (event) => {
        if (event.button !== 0 || !canStartWindowDrag(event.clientX, event.clientY, event.target)) return;
        draggingWindow = true;
        activePointerId = event.pointerId;
        if (event.target && event.target.setPointerCapture) {
          try { event.target.setPointerCapture(event.pointerId); } catch (_error) {}
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.start(event.screenX, event.screenY);
      }, true);
      window.addEventListener('pointermove', (event) => {
        if (!draggingWindow || (activePointerId !== null && event.pointerId !== activePointerId)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (window.__leagueElectronDrag) window.__leagueElectronDrag.move(event.screenX, event.screenY);
      }, true);
      window.addEventListener('pointerup', endWindowDrag, true);
      window.addEventListener('pointercancel', endWindowDrag, true);
      window.addEventListener('blur', endWindowDrag, true);
      let queued = false;
      const markChrome = () => {
        queued = false;
        for (const selector of dragSelectors) {
          for (const element of document.querySelectorAll(selector)) {
            for (const child of element.querySelectorAll(interactiveSelector)) {
              child.dataset.electronNoDrag = 'true';
            }
            for (const child of element.querySelectorAll('*')) {
              const style = getComputedStyle(child);
              if (style.cursor === 'pointer') child.dataset.electronNoDrag = 'true';
            }
          }
        }
      };
      const scheduleMarkChrome = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(markChrome);
      };
      window.addEventListener('DOMContentLoaded', () => {
        window.__setLeagueElectronSize(window.innerWidth, window.innerHeight);
        hideOpenPartyTooltip();
        scheduleMarkChrome();
        new MutationObserver(() => {
          hideOpenPartyTooltip();
          scheduleMarkChrome();
        }).observe(document.body, { childList: true, subtree: true, characterData: true });
      });
    })();
  `.replace(/\s+/g, ' ').trim();
}

const assetCache = new Map();
const wadFilesCache = new Map();

function pluginNameForSegment(segment) {
  return segment === 'plugin-runner' ? 'rcp-fe-plugin-runner' : `${FRONTEND_PREFIX}${segment}`;
}

function wadFilesForPlugin(pluginName) {
  if (wadFilesCache.has(pluginName)) return wadFilesCache.get(pluginName);

  const pluginDir = path.join(PLUGINS_DIR, pluginName);
  if (!fs.existsSync(pluginDir)) return [];

  const wadFiles = fs.readdirSync(pluginDir)
    .filter((file) => file.endsWith('.wad'))
    .map((file) => path.join(pluginDir, file));
  wadFilesCache.set(pluginName, wadFiles);
  return wadFiles;
}

function assetCandidateForPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const feMatch = decodedPath.match(/^fe\/([^/]+)\/(.+)$/);
  if (feMatch) {
    const [, segment, relativePath] = feMatch;
    return {
      pluginName: pluginNameForSegment(segment),
      relativePath
    };
  }

  if (/^(images|sounds|videos|fonts)\//.test(decodedPath)) {
    return {
      pluginName: STATIC_PLUGIN,
      relativePath: decodedPath
    };
  }

  return null;
}

async function extractAsset(urlPath) {
  const candidate = assetCandidateForPath(urlPath);
  if (!candidate) return null;

  const { pluginName, relativePath } = candidate;
  const cacheKey = `${pluginName}:${relativePath}`;
  if (assetCache.has(cacheKey)) return assetCache.get(cacheKey);

  const fileInpack = `plugins/${pluginName}/global/default/${relativePath}`;
  let extracted = [];
  for (const candidateWad of wadFilesForPlugin(pluginName)) {
    extracted = await extractWAD(candidateWad, [{ fileInpack }]);
    if (extracted.length) break;
  }
  if (!extracted.length) {
    if (relativePath.endsWith('.css')) return { buffer: Buffer.from(''), fileName: path.basename(relativePath) };
    assetCache.set(cacheKey, null);
    return null;
  }

  const asset = { buffer: extracted[0].buffer, fileName: path.basename(relativePath) };
  assetCache.set(cacheKey, asset);
  return asset;
}

function contentType(fileName) {
  if (fileName.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (fileName.endsWith('.css')) return 'text/css; charset=utf-8';
  if (fileName.endsWith('.json')) return 'application/json; charset=utf-8';
  if (fileName.endsWith('.png')) return 'image/png';
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) return 'image/jpeg';
  if (fileName.endsWith('.svg')) return 'image/svg+xml';
  if (fileName.endsWith('.webm')) return 'video/webm';
  if (fileName.endsWith('.mp4')) return 'video/mp4';
  if (fileName.endsWith('.ogg')) return 'audio/ogg';
  if (fileName.endsWith('.wav')) return 'audio/wav';
  if (fileName.endsWith('.ttf')) return 'font/ttf';
  if (fileName.endsWith('.otf')) return 'font/otf';
  if (fileName.endsWith('.woff')) return 'font/woff';
  if (fileName.endsWith('.woff2')) return 'font/woff2';
  return 'application/octet-stream';
}

async function handleRiotInvoke(win, payload) {
  let request = payload && payload.request;
  if (typeof request === 'string') request = JSON.parse(request);
  if (!request || typeof request.name !== 'string') return undefined;

  const params = Array.isArray(request.params) ? request.params : [];
  switch (request.name) {
    case 'Window.Close':
    case 'Window.Exit':
    case 'Window.Quit':
    case 'Client.Exit':
    case 'Client.Quit':
    case 'RiotClient.Exit':
    case 'RiotClient.Quit':
      win.close();
      return undefined;
    case 'Window.Minimize':
      win.minimize();
      return undefined;
    case 'Window.Restore':
    case 'Window.Activate':
      win.restore();
      win.focus();
      return undefined;
    case 'Window.Show':
      win.show();
      return undefined;
    case 'Window.Hide':
      win.hide();
      return undefined;
    case 'Window.ResizeTo':
      if (params.length >= 2) applyWindowSize(win, windowSizeForDimensions(Number(params[0]), Number(params[1])));
      return undefined;
    case 'Window.MoveTo':
      if (params.length >= 2) win.setPosition(Number(params[0]), Number(params[1]));
      return undefined;
    case 'Window.GetValidWindowSizes':
      return riotResult(WINDOW_SIZES.map((size) => ({
        ...size,
        selected: size.scale === currentWindowScale(win)
      })));
    case 'Window.ScreenData': {
      const bounds = win.getBounds();
      const display = require('electron').screen.getDisplayMatching(bounds);
      return riotResult({
        screenX: bounds.x,
        screenY: bounds.y,
        screenWidth: display.bounds.width,
        screenHeight: display.bounds.height,
        screenAvailWidth: display.workArea.width,
        screenAvailHeight: display.workArea.height,
        screenAvailLeft: display.workArea.x,
        screenAvailTop: display.workArea.y,
        windowWidth: bounds.width,
        windowHeight: bounds.height,
        windowActivated: win.isFocused(),
        windowMinimized: win.isMinimized(),
        zoomScale: currentWindowScale(win)
      });
    }
    case 'Window.CenterToScreen':
    case 'Window.CenterWithinMainWindow':
    case 'Window.CenterWithinParent':
      win.center();
      return undefined;
    case 'Window.SetTitle':
      if (typeof params[0] === 'string') win.setTitle(params[0]);
      return undefined;
    case 'Window.Flash':
      win.flashFrame(true);
      return undefined;
    case 'Mouse.SetDragBarHeight':
      return undefined;
    case 'Client.Logout':
    case 'Client.SignOut':
    case 'Auth.Logout':
    case 'Auth.SignOut':
    case 'RiotClient.SignOut':
    case 'RiotClient.Logout':
      await requestLeague('/lol-login/v1/session', win.league.port, win.league.token, 'DELETE');
      win.close();
      return undefined;
    case 'Browser.OpenExternal':
    case 'Window.OpenExternal':
      if (typeof params[0] === 'string') await shell.openExternal(params[0]);
      return undefined;
    default:
      if (DEBUG) console.log(`[riotInvoke:unhandled] ${request.name} ${JSON.stringify(params).slice(0, 500)}`);
      return undefined;
  }
}

function sendBuffer(req, res, asset) {
  const type = contentType(asset.fileName);
  const total = asset.buffer.length;
  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : total - 1;
      if (start <= end && end < total) {
        res.writeHead(206, {
          'content-type': type,
          'content-length': end - start + 1,
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'cache-control': 'no-cache'
        });
        if (req.method === 'HEAD') return res.end();
        return res.end(asset.buffer.subarray(start, end + 1));
      }
    }
  }

  res.writeHead(200, {
    'content-type': type,
    'content-length': total,
    'accept-ranges': 'bytes',
    'cache-control': 'no-cache'
  });
  if (req.method === 'HEAD') return res.end();
  return res.end(asset.buffer);
}

function proxyLeague(req, res, league) {
  const bodyChunks = [];
  req.on('data', (chunk) => bodyChunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);
    const handled = handleLocalBridgeRoute(req, res, league, body);
    if (handled) return;

    forwardLeagueRequest(req, res, league, body);
  });
}

function handleLocalBridgeRoute(req, res, league, body) {
  const requestUrl = new URL(req.url, 'http://127.0.0.1');

  if (requestUrl.pathname === '/lol-platform-config/v1/namespaces/LcuUxSettings') {
    return sendJson(res, {
      WindowSizeDefault: 1,
      WindowSizeOptions: WINDOW_SIZES.map(({ width, height, scale }) => ({ width, height, scale }))
    });
  }

  if (/^\/lol-settings\/v\d+\/(?:account|local)\/(?:LCUPreferences\/)?lol-parties$/.test(requestUrl.pathname)) {
    return sendJson(res, {
      data: {
        hasSeenOpenPartyFirstExperience: true,
        hasSeenOpenPartyTooltip: true,
        hasSeenPartyOpenTooltip: true,
        showOpenPartyTooltip: false
      },
      schemaVersion: 1
    });
  }

  if (/^\/lol-lobby\/v2\/notifications\/[^/]+$/.test(requestUrl.pathname) && req.method === 'DELETE') {
    res.writeHead(204);
    res.end();
    return true;
  }

  if (/^\/lol-settings\/v\d+\/local\/(?:LCUPreferences\/)?video$/.test(requestUrl.pathname) && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    const parsed = parseJsonBody(body);
    const scale = parsed && (parsed.ZoomScale ?? parsed.data?.ZoomScale);
    if (scale !== undefined && BrowserWindow.getAllWindows()[0]) {
      applyWindowSize(BrowserWindow.getAllWindows()[0], windowSizeForScale(scale), true);
    }
  }

  return false;
}

function sendJson(res, value, statusCode = 200) {
  res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(JSON.stringify(value));
  return true;
}

function parseJsonBody(body) {
  if (!body || !body.length) return null;
  try {
    return JSON.parse(body.toString('utf8'));
  } catch (_error) {
    return null;
  }
}

function forwardLeagueRequest(req, res, league, body) {
  const proxyReq = https.request({
    hostname: '127.0.0.1',
    port: league.port,
    path: req.url,
    method: req.method,
    rejectUnauthorized: false,
    auth: `riot:${league.token}`,
    headers: {
      ...req.headers,
      host: `127.0.0.1:${league.port}`,
      authorization: `Basic ${Buffer.from(`riot:${league.token}`).toString('base64')}`,
      ...(body.length ? { 'content-length': body.length } : {})
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });

  if (body.length) proxyReq.write(body);
  proxyReq.end();
}

function startBridgeServer(league) {
  const plugins = frontendPlugins();
  const graph = buildDependencyGraph(plugins.filter((plugin) => plugin.name !== 'rcp-fe-plugin-runner'));
  let indexHtml = '';

  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (requestUrl.pathname === '/' || requestUrl.pathname === '/bootstrap.html' || requestUrl.pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(indexHtml);
        return;
      }

      if (requestUrl.pathname === '/graph.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(graph));
        return;
      }

      if (requestUrl.pathname === '/fe/lol-l10n/moment-locale.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
        res.end('');
        return;
      }

      const asset = await extractAsset(requestUrl.pathname);
      if (asset) {
        sendBuffer(req, res, asset);
        return;
      }

      proxyLeague(req, res, league);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  const wsServer = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(req, socket, head, (clientSocket) => {
      const upstream = new WebSocket(`wss://riot:${league.token}@127.0.0.1:${league.port}/`, ['wamp'], {
        rejectUnauthorized: false,
        headers: { Origin: `https://127.0.0.1:${league.port}` }
      });

      upstream.on('open', () => {
        console.log('[bridge] websocket open');
      });
      upstream.on('message', (message, isBinary) => {
        if (DEBUG) console.log(`[bridge] websocket <= ${message.toString().slice(0, 200)}`);
        if (clientSocket.readyState === WebSocket.OPEN) clientSocket.send(message, { binary: isBinary });
      });
      clientSocket.on('message', (message, isBinary) => {
        if (DEBUG) console.log(`[bridge] websocket => ${message.toString().slice(0, 200)}`);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(message, { binary: isBinary });
      });
      upstream.on('close', (code, reason) => clientSocket.close(code, reason));
      clientSocket.on('close', () => upstream.close());
      upstream.on('error', (error) => {
        console.log(`[bridge] websocket upstream error ${error.message}`);
        clientSocket.close();
      });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      indexHtml = buildIndexHtml(league, port);
      console.log(`[bridge] http://127.0.0.1:${port}/index.html`);
      resolve({ server, port });
    });
  });
}

function requestLeague(path, port, token, method = 'GET', body = null) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      rejectUnauthorized: false,
      auth: `riot:${token}`,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': LEAGUE_UA,
        ...(payload ? {
          'content-type': 'application/json',
          'content-length': payload.length
        } : {})
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ path, statusCode: res.statusCode, body }));
    });

    req.on('error', (error) => resolve({ path, error }));
    if (payload) req.write(payload);
    req.end();
  });
}

async function createWindow() {
  const league = readLeagueUxArgs();
  const baseUrl = `https://127.0.0.1:${league.port}`;
  const bridge = await startBridgeServer(league);
  Menu.setApplicationMenu(null);

  const checks = await Promise.all([
    requestLeague('/bootstrap.html', league.port, league.token),
    requestLeague('/index.html', league.port, league.token),
    requestLeague('/plugin-manager/v1/status', league.port, league.token)
  ]);

  for (const check of checks) {
    const preview = check.error ? check.error.message : check.body.slice(0, 120).replace(/\s+/g, ' ');
    console.log(`[league] ${check.path}: ${check.statusCode || 'ERR'} ${preview}`);
  }

  const win = new BrowserWindow({
    width: WINDOW_SIZES[1].width,
    height: WINDOW_SIZES[1].height,
    title: 'League Electron Client',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    frame: false,
    thickFrame: false,
    resizable: false,
    useContentSize: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  win.league = league;
  applyWindowSize(win, WINDOW_SIZES[1], true);
  await applySavedWindowSize(win, league).catch((error) => {
    if (DEBUG) console.log(`[settings] could not apply saved window size: ${error.message}`);
  });

  session.defaultSession.setUserAgent(LEAGUE_UA);
  session.defaultSession.setCertificateVerifyProc((_request, callback) => {
    callback(0);
  });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders.Authorization = `Basic ${Buffer.from(`riot:${league.token}`).toString('base64')}`;
    callback({ requestHeaders: details.requestHeaders });
  });
  session.defaultSession.webRequest.onCompleted((details) => {
    if (details.statusCode >= 400 && (DEBUG || details.url.includes('/fe/'))) {
      console.log(`[request:${details.statusCode}] ${details.method} ${details.url}`);
    }
  });
  session.defaultSession.webRequest.onErrorOccurred((details) => {
    const normalMediaCancel = details.error === 'net::ERR_ABORTED' || details.error === 'net::ERR_CACHE_MISS';
    if (DEBUG || (!normalMediaCancel && details.url.includes('/fe/'))) {
      console.log(`[request:error] ${details.error} ${details.method} ${details.url}`);
    }
  });

  win.webContents.on('certificate-error', (event, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(true);
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[electron] did-fail-load ${errorCode} ${errorDescription} ${validatedURL}`);
  });

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    if (DEBUG || level >= 3) {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    }
  });

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[electron] render-process-gone ${details.reason}`);
  });

  win.webContents.on('unresponsive', () => {
    console.error('[electron] renderer unresponsive');
  });

  win.webContents.on('did-finish-load', async () => {
    const location = await win.webContents.executeJavaScript('location.href').catch(() => '');
    console.log(`[electron] loaded ${location}`);
    await applySavedWindowSize(win, league).catch((error) => {
      if (DEBUG) console.log(`[settings] could not reapply saved window size: ${error.message}`);
    });
    if (!DEBUG) return;

    const captureDebugState = async (label) => {
      const image = await win.capturePage().catch(() => null);
      if (image) {
        const screenshotPath = path.join(__dirname, `league-electron-screenshot-${label}.png`);
        fs.writeFileSync(screenshotPath, image.toPNG());
        console.log(`[electron] screenshot ${screenshotPath}`);
      }
      const state = await win.webContents.executeJavaScript(`({
        href: location.href,
        title: document.title,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        bodyWidth: document.body && document.body.getBoundingClientRect().width,
        bodyHeight: document.body && document.body.getBoundingClientRect().height,
        bodyTransform: document.body && getComputedStyle(document.body).transform,
        manualDragAt100x10: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(100, 10),
        manualDragAt500x10: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(500, 10),
        manualDragAtRightControls: window.__leagueElectronCanDragPoint && window.__leagueElectronCanDragPoint(window.innerWidth - 80, 10),
        dragElementTag: document.elementFromPoint(100, 10) && document.elementFromPoint(100, 10).tagName,
        dragElementRegion: document.elementFromPoint(100, 10) && getComputedStyle(document.elementFromPoint(100, 10)).webkitAppRegion,
        partyTooltipTextPresent: document.body.innerText.toUpperCase().includes('PARTY IS OPEN'),
        scripts: document.scripts.length,
        loadingExists: !!document.getElementById('index_loading_div_20210908'),
        bodyText: document.body.innerText.slice(0, 500),
        riotPluginLoadTimes: window._riotPluginLoadTimes,
        keys: Object.keys(window).filter(k => k.startsWith('riot') || k.startsWith('Riot')).slice(0, 50)
      })`).catch((error) => ({ error: error.message }));
      console.log(`[electron] state:${label} ${JSON.stringify({
        ...state,
        contentSize: win.getContentSize(),
        bounds: win.getBounds(),
        zoomFactor: win.webContents.getZoomFactor()
      }).slice(0, 2000)}`);
    };
    setTimeout(() => captureDebugState('10s'), 10000);
    setTimeout(() => captureDebugState('25s'), 25000);
  });

  console.log(`[league] Loading bridge for ${baseUrl}/bootstrap.html`);
  await win.loadURL(`http://127.0.0.1:${bridge.port}/index.html`);
}

app.whenReady().then(createWindow).catch((error) => {
  console.error(error);
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
