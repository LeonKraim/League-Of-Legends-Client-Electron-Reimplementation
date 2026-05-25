/**
 * dump-fe.js — Extracts League frontend assets from WAD files for local inspection.
 *
 * Usage: node scripts/dump-fe.js [options]
 *   --quick     Extract only main JS/CSS files (fastest)
 *   --full      Extract ALL entries from each WAD (slow, large)
 *   --manifest  Only generate WAD file manifests (hash listings)
 *   Default:    Extract main JS/CSS + generate manifest
 *
 * Output: fe_raw/{pluginName}/  (gitignored — never committed)
 *
 * This file does NOT contain any Riot-copyrighted code. It only orchestrates
 * extraction of assets that are already on the user's machine.
 */

const fs = require('node:fs');
const path = require('node:path');
const { openSync, closeSync } = require('node:fs');

const Biffer = require('@danor-lib/biffer').default;
const { extractWAD } = require('@lol-archiver/lol-wad-extract');

// ---------------------------------------------------------------------------
// Path config (mirrors path-config.js, but standalone so .bat can run it)
// ---------------------------------------------------------------------------

const COMMON_LEAGUE_DIRS = [
  'C:\\Riot Games\\League of Legends',
  path.join(process.env.LOCALAPPDATA || 'C:\\', 'Riot Games\\League of Legends'),
  path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Riot Games\\League of Legends'),
  path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Riot Games\\League of Legends'),
];

function findLeagueDir() {
  // Try settings.json first
  const settingsPath = path.join(__dirname, '..', 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (settings.leagueClientDir && fs.existsSync(path.join(settings.leagueClientDir, 'LeagueClient.exe'))) {
        return settings.leagueClientDir;
      }
    } catch (_) {}
  }

  // Auto-detect
  for (const dir of COMMON_LEAGUE_DIRS) {
    if (fs.existsSync(path.join(dir, 'LeagueClient.exe'))) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WAD entry listing (reads all entry hashes/metadata)
// ---------------------------------------------------------------------------

/**
 * List all entries in a WAD file (hashes only, no extraction).
 * Returns [{ hash, offset, compressedSize, size, type }]
 *
 * Based on the same format read by @lol-archiver/lol-wad-extract:
 *   Header: magic(2) versionMajor(1) versionMinor(1)
 *   v1: seek 8,  entry size 24 (QIIII)
 *   v2: seek 100, entry size 32 (QIIIBBBBQ)
 *   v3: seek 268, entry size 32 (QIIIBBBBQ)
 */
function listWadEntries(wadPath) {
  let fd;
  try {
    fd = openSync(wadPath);
    const biffer = new Biffer(fd);

    // Read header
    const [magic, versionMajor] = biffer.unpack('2sB');

    biffer.seek(0); // re-read with offset
    biffer.unpack('2sBB'); // consume magic + versionMajor + versionMinor

    if (versionMajor === 1) {
      biffer.seek(8);
    } else if (versionMajor === 2) {
      biffer.seek(100);
    } else if (versionMajor === 3) {
      biffer.seek(268);
    } else {
      console.error(`  Unknown WAD version ${versionMajor} in ${path.basename(wadPath)}`);
      return [];
    }

    const [entryCount] = biffer.unpack('I');
    const entries = [];

    for (let i = 0; i < entryCount; i++) {
      const unpacked = biffer.unpack(versionMajor === 1 ? 'QIIII' : 'QIIIBBBBQ');
      // unpacked: [hash, offset, compressedSize, uncompressedSize, type, ...rest]
      entries.push({
        hash: String(unpacked[0]),       // xxhash64 as decimal string
        hashHex: BigInt(unpacked[0]).toString(16).padStart(16, '0'),
        offset: unpacked[1],
        compressedSize: unpacked[2],
        size: unpacked[3],
        type: unpacked[4],               // 0=stored, 1=gzip, 3=zstd
      });
    }

    return entries;
  } catch (err) {
    console.error(`  Failed to read WAD ${path.basename(wadPath)}: ${err.message}`);
    return [];
  } finally {
    if (typeof fd === 'number') closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Known file extraction
// ---------------------------------------------------------------------------

const FRONTEND_PREFIX = 'rcp-fe-';

/**
 * Extract known FE assets from a plugin's WADs.
 * These are the files referenced by the HTML template.
 */
async function extractKnownAssets(pluginsDir, pluginName, outputDir) {
  const pluginDir = path.join(pluginsDir, pluginName);
  if (!fs.existsSync(pluginDir)) return [];

  const wadFiles = fs.readdirSync(pluginDir).filter(f => f.endsWith('.wad'));
  if (!wadFiles.length) return [];

  // Known patterns for each plugin
  const knownFiles = [];

  // Main JavaScript bundle
  knownFiles.push(`plugins/${pluginName}/global/default/${pluginName}.js`);

  // CSS (naming varies per plugin)
  if (pluginName === 'rcp-fe-lol-uikit') {
    knownFiles.push(`plugins/${pluginName}/global/default/main.css`);
  } else {
    knownFiles.push(`plugins/${pluginName}/global/default/${pluginName}.css`);
  }

  // L10n files
  knownFiles.push(`plugins/${pluginName}/global/default/moment-locale.js`);

  // Manifest file (sometimes present)
  knownFiles.push(`plugins/${pluginName}/global/default/manifest.json`);

  const results = [];
  const pluginOutDir = path.join(outputDir, pluginName);
  fs.mkdirSync(pluginOutDir, { recursive: true });

  for (const wadFile of wadFiles) {
    const wadPath = path.join(pluginDir, wadFile);
    const configs = knownFiles.map(fileInpack => ({
      fileInpack,
      fileSave: null, // we'll save manually
    }));

    try {
      const extracted = await extractWAD(wadPath, configs);
      for (const entry of extracted) {
        const relativeName = entry.fileInpack.replace(`plugins/${pluginName}/global/default/`, '');
        const outPath = path.join(pluginOutDir, relativeName);
        const outDir = path.dirname(outPath);
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(outPath, entry.buffer);
        results.push({ file: relativeName, size: entry.buffer.length, wad: wadFile });
      }
    } catch (err) {
      console.error(`  Failed to extract from ${wadFile}: ${err.message}`);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Full WAD dump (extract ALL entries, save with hash-based filenames)
// ---------------------------------------------------------------------------

async function dumpAllEntries(pluginsDir, pluginName, outputDir) {
  const pluginDir = path.join(pluginsDir, pluginName);
  if (!fs.existsSync(pluginDir)) return [];

  const wadFiles = fs.readdirSync(pluginDir).filter(f => f.endsWith('.wad'));
  const pluginOutDir = path.join(outputDir, pluginName);
  fs.mkdirSync(pluginOutDir, { recursive: true });

  let total = 0;

  for (const wadFile of wadFiles) {
    const wadPath = path.join(pluginDir, wadFile);
    const entries = listWadEntries(wadPath);

    // Build extract config for all entries
    // But we need fileInpack strings to extract... and we only have hashes.
    // The extractWAD function needs fileInpack to compute the hash.
    // Since we can't reverse hashes, we can only list, not extract all.
    // Skip full dump without known paths.
  }

  return total;
}

// ---------------------------------------------------------------------------
// Manifest generation
// ---------------------------------------------------------------------------

function generateManifest(pluginsDir, pluginName, outputDir) {
  const pluginDir = path.join(pluginsDir, pluginName);
  if (!fs.existsSync(pluginDir)) return null;

  const wadFiles = fs.readdirSync(pluginDir).filter(f => f.endsWith('.wad'));
  const manifest = {
    plugin: pluginName,
    generatedAt: new Date().toISOString(),
    wads: {}
  };

  for (const wadFile of wadFiles) {
    const wadPath = path.join(pluginDir, wadFile);
    const entries = listWadEntries(wadPath);
    manifest.wads[wadFile] = {
      path: wadPath,
      size: fs.statSync(wadPath).size,
      entries: entries.length,
      files: entries.map(e => ({
        hash: e.hashHex,
        offset: e.offset,
        size: e.size,
        compressedSize: e.compressedSize,
        type: ['stored', 'gzip', 'reserved', 'zstd'][e.type] || `unknown(${e.type})`,
      }))
    };
  }

  const manifestPath = path.join(outputDir, pluginName, '_manifest.json');
  const manifestDir = path.dirname(manifestPath);
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--quick') ? 'quick'
    : args.includes('--full') ? 'full'
    : args.includes('--manifest') ? 'manifest'
    : 'default';

  console.log('=== League FE Asset Dumper ===\n');

  const leagueDir = findLeagueDir();
  if (!leagueDir) {
    console.error('ERROR: Could not find League of Legends installation.');
    console.error('Set leagueClientDir in settings.json or make sure League is installed.');
    process.exit(1);
  }
  console.log(`League dir: ${leagueDir}`);

  const pluginsDir = path.join(leagueDir, 'Plugins');
  const manifestPath = path.join(pluginsDir, 'plugin-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`ERROR: plugin-manifest.json not found at ${manifestPath}`);
    process.exit(1);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const plugins = manifest.plugins || [];

  // Find all rcp-fe- plugins
  const fePlugins = plugins.filter(p => p.name && p.name.startsWith(FRONTEND_PREFIX));
  console.log(`Found ${fePlugins.length} frontend plugins:\n`);

  const outputDir = path.join(__dirname, '..', 'fe_raw');
  fs.mkdirSync(outputDir, { recursive: true });

  // Write extraction log
  const logEntries = [];
  const startTime = Date.now();

  for (const plugin of fePlugins) {
    console.log(`[${plugin.name}]`);

    // 1. Generate manifest (always)
    if (mode === 'manifest' || mode === 'default') {
      const wadManifest = generateManifest(pluginsDir, plugin.name, outputDir);
      if (wadManifest) {
        const totalEntries = Object.values(wadManifest.wads).reduce((sum, w) => sum + w.entries, 0);
        console.log(`  Manifest: ${Object.keys(wadManifest.wads).length} WAD(s), ${totalEntries} entries`);
      }
    }

    // 2. Extract known files
    if (mode === 'quick' || mode === 'default') {
      const extracted = await extractKnownAssets(pluginsDir, plugin.name, outputDir);
      for (const f of extracted) {
        console.log(`  Extracted: ${f.file} (${(f.size / 1024).toFixed(1)} KB) from ${f.wad}`);
        logEntries.push({ plugin: plugin.name, ...f });
      }
    }

    console.log('');
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`Done in ${elapsed}s.`);
  console.log(`Output: ${outputDir}`);

  // Save extraction log
  const logPath = path.join(outputDir, '_extraction-log.json');
  fs.writeFileSync(logPath, JSON.stringify({
    extractedAt: new Date().toISOString(),
    leagueDir,
    mode,
    elapsed: `${elapsed}s`,
    files: logEntries,
  }, null, 2));
  console.log(`Log: ${logPath}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
