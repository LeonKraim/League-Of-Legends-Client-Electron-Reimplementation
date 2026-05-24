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

  return `<!doctype html><html><head>  <base href='/'>  <meta charset='utf-8'>  <meta name='viewport' content='width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=0' />  <link rel='riot:plugins:dependency-graph' href='/graph.json' />  <link rel='riot:plugins:websocket' href='ws://127.0.0.1:${bridgePort}/ws' />  ${cssHtml}  <script>window.getPluginAnnounceEventName = (pluginName) => \`riotPlugin.announce:\${pluginName}\`;</script>${scriptTags.join('')}</head><body data-env='public' data-loading-div-id='index_loading_div_20210908'>  <div id='index_loading_div_20210908' style='position: fixed;display: flex;align-items: center;justify-content: center;flex-direction: column;pointer-events: all;top: 0;left: 0;width: 100%;height: 100%;direction: ltr;'>    <img src='/lol-game-data/assets/ASSETS/SplashScreens/lol_icon.png'>  </div>  <script src='/fe/plugin-runner/rcp-fe-plugin-runner.js?t=${timestamp}'></script></body></html>`;
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
      win.close();
      return undefined;
    case 'Window.Minimize':
      win.minimize();
      return undefined;
    case 'Window.Show':
      win.show();
      return undefined;
    case 'Window.ResizeTo':
      if (params.length >= 2) win.setSize(Number(params[0]), Number(params[1]));
      return undefined;
    case 'Window.CenterToScreen':
      win.center();
      return undefined;
    case 'Browser.OpenExternal':
    case 'Window.OpenExternal':
      if (typeof params[0] === 'string') await shell.openExternal(params[0]);
      return undefined;
    default:
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
      authorization: `Basic ${Buffer.from(`riot:${league.token}`).toString('base64')}`
    }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: error.message }));
  });

  req.pipe(proxyReq);
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

function requestLeague(path, port, token) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      rejectUnauthorized: false,
      auth: `riot:${token}`,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'User-Agent': LEAGUE_UA
      }
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ path, statusCode: res.statusCode, body }));
    });

    req.on('error', (error) => resolve({ path, error }));
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
    width: 1280,
    height: 720,
    title: 'League Electron Client',
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    }
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

  win.webContents.on('did-finish-load', async () => {
    const location = await win.webContents.executeJavaScript('location.href').catch(() => '');
    console.log(`[electron] loaded ${location}`);
    if (!DEBUG) return;

    setTimeout(async () => {
      const image = await win.capturePage().catch(() => null);
      if (image) {
        const screenshotPath = path.join(__dirname, 'league-electron-screenshot.png');
        fs.writeFileSync(screenshotPath, image.toPNG());
        console.log(`[electron] screenshot ${screenshotPath}`);
      }
      const state = await win.webContents.executeJavaScript(`({
        href: location.href,
        title: document.title,
        scripts: document.scripts.length,
        loadingExists: !!document.getElementById('index_loading_div_20210908'),
        bodyText: document.body.innerText.slice(0, 500),
        riotPluginLoadTimes: window._riotPluginLoadTimes,
        keys: Object.keys(window).filter(k => k.startsWith('riot') || k.startsWith('Riot')).slice(0, 50)
      })`).catch((error) => ({ error: error.message }));
      console.log(`[electron] state ${JSON.stringify(state).slice(0, 2000)}`);
    }, 10000);
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
