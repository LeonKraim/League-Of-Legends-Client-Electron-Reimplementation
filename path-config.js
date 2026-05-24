const fs = require('node:fs');
const path = require('node:path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

const COMMON_LEAGUE_DIRS = [
  'C:\\Riot Games\\League of Legends',
  path.join(process.env.LOCALAPPDATA || 'C:\\', 'Riot Games\\League of Legends'),
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Riot Games\\League of Legends'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Riot Games\\League of Legends'),
];

const COMMON_RIOT_DIRS = [
  'C:\\Riot Games\\Riot Client',
  path.join(process.env.LOCALAPPDATA || 'C:\\', 'Riot Games\\Riot Client'),
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Riot Games\\Riot Client'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Riot Games\\Riot Client'),
];

let configError = null;
let paths = {};

function findFirstExisting(dirs, exeName) {
  for (const dir of dirs) {
    const exePath = path.join(dir, exeName);
    if (fs.existsSync(exePath)) {
      return dir;
    }
  }
  return null;
}

function loadConfig() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      console.error('[path-config] Failed to parse settings.json:', e.message);
    }
  }

  const leagueDirSetting = settings.leagueClientDir || '';
  const riotDirSetting = settings.riotClientDir || '';

  if (leagueDirSetting && fs.existsSync(path.join(leagueDirSetting, 'LeagueClient.exe'))) {
    paths.leagueDir = leagueDirSetting;
  }
  if (riotDirSetting && fs.existsSync(path.join(riotDirSetting, 'RiotClientServices.exe'))) {
    paths.riotDir = riotDirSetting;
  }

  if (!paths.leagueDir) {
    const found = findFirstExisting(COMMON_LEAGUE_DIRS, 'LeagueClient.exe');
    if (found) paths.leagueDir = found;
  }

  if (!paths.riotDir) {
    const found = findFirstExisting(COMMON_RIOT_DIRS, 'RiotClientServices.exe');
    if (found) paths.riotDir = found;
  }

  if (!paths.leagueDir) {
    configError = 'Auto configuring of league client path failed, please set it yourself in the settings.json in the Electron client folder';
  }
  if (!paths.riotDir) {
    configError = 'Auto configuring of league client path failed, please set it yourself in the settings.json in the Electron client folder';
  }
}

loadConfig();

module.exports = {
  get leagueDir() { return paths.leagueDir; },
  get riotDir() { return paths.riotDir; },
  get leagueClientExe() { return paths.leagueDir ? path.join(paths.leagueDir, 'LeagueClient.exe') : null; },
  get riotClientServicesExe() { return paths.riotDir ? path.join(paths.riotDir, 'RiotClientServices.exe') : null; },
  get pluginsDir() { return paths.leagueDir ? path.join(paths.leagueDir, 'Plugins') : null; },
  get configError() { return configError; },
};
