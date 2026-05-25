const { packager } = require('@electron/packager');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const buildId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const NAME = `League-Electron-Client-${buildId}`;
const { version } = require(path.join(ROOT, 'package.json'));

async function packageApp() {
  const appPaths = await packager({
    dir: ROOT,
    name: NAME,
    platform: 'win32',
    arch: 'x64',
    out: DIST,
    asar: true,
    overwrite: true
  });
  return appPaths[0];
}

function zipApp(appDir) {
  const zipName = `${NAME}-${version}-win32-x64.zip`;
  console.log(`Creating ${zipName}...`);
  execFileSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `Compress-Archive -Path '${appDir}\\*' -DestinationPath '${path.join(DIST, zipName)}' -Force`
  ], { cwd: ROOT, stdio: 'inherit' });
  console.log(`Created ${path.join(DIST, zipName)}`);
}

(async () => {
  console.log('Building League Electron Client...');
  const appDir = await packageApp();
  console.log(`Packaged to ${appDir}`);
  zipApp(appDir);
  console.log('Done.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
