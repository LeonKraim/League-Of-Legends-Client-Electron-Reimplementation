/**
 * test-patcher.js — Verifies the FE patcher system works end-to-end.
 *
 * Tests:
 *   1. Patch loading from patches/ folder
 *   2. Match rules (plugin, file, ext, wildcard)
 *   3. Transform types: replace, regex, prepend, append, inject-css
 *   4. Buffer → patched buffer round-trip
 *   5. Generated HTML patching
 *
 * Usage: node scripts/test-patcher.js
 */

const path = require('node:path');
const fePatcher = require('./fe-patcher');
const { _testing } = fePatcher;

const PATCHES_DIR = path.join(__dirname, '..', 'patches');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function section(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

// ---------------------------------------------------------------------------
// Test 1: Patch loading
// ---------------------------------------------------------------------------
section('Test 1: Patch loading');

const patches = fePatcher.loadPatches(PATCHES_DIR);
assert(patches.length > 0, `Loaded ${patches.length} patch(es)`);
assert(patches.every(p => typeof p.id === 'string'), 'All patches have an id');
assert(patches.every(p => Array.isArray(p.transforms)), 'All patches have transforms array');

for (const p of patches) {
  console.log(`    • ${p.id} [${p.enabled !== false ? 'enabled' : 'disabled'}] — ${p.description || '(no desc)'} — ${p.transforms.length} transform(s)`);
}

// ---------------------------------------------------------------------------
// Test 2: Match rules
// ---------------------------------------------------------------------------
section('Test 2: Match rules — plugin matching');

const mockAsset = (pluginName, relativePath) => ({
  pluginName,
  relativePath,
  fileName: path.basename(relativePath),
});

// Exact plugin match
const patchPluginMatch = { match: { plugin: 'rcp-fe-lol-uikit' } };
assert(_testing.patchMatches(patchPluginMatch, mockAsset('rcp-fe-lol-uikit', 'main.css')), 'exact plugin match: true');
assert(!_testing.patchMatches(patchPluginMatch, mockAsset('rcp-fe-lol-champ-select', 'main.css')), 'exact plugin match: false for different plugin');

// Wildcard plugin
const patchWildPlugin = { match: { plugin: '*' } };
assert(_testing.patchMatches(patchWildPlugin, mockAsset('rcp-fe-lol-uikit', 'main.css')), 'wildcard plugin: true');
assert(_testing.patchMatches(patchWildPlugin, mockAsset('rcp-fe-lol-champ-select', 'bundle.js')), 'wildcard plugin: true for any');

// Plugin prefix
const patchPrefix = { match: { pluginPrefix: 'rcp-fe-lol-' } };
assert(_testing.patchMatches(patchPrefix, mockAsset('rcp-fe-lol-uikit', 'x.css')), 'plugin prefix match');
assert(_testing.patchMatches(patchPrefix, mockAsset('rcp-fe-lol-champ-select', 'x.css')), 'plugin prefix match 2');
assert(!_testing.patchMatches(patchPrefix, mockAsset('rcp-fe-plugin-runner', 'x.css')), 'plugin prefix: false (plugin-runner)');

// File match
const patchFileExact = { match: { file: 'main.css' } };
assert(_testing.patchMatches(patchFileExact, mockAsset('any-plugin', 'main.css')), 'exact filename match');
assert(!_testing.patchMatches(patchFileExact, mockAsset('any-plugin', 'other.css')), 'exact filename: false for different file');

// File regex
const patchFileRegex = { match: { file: /\.css$/ } };
assert(_testing.patchMatches(patchFileRegex, mockAsset('any', 'style.css')), 'regex filename match');
assert(!_testing.patchMatches(patchFileRegex, mockAsset('any', 'script.js')), 'regex filename: false for .js');

// Extension match
const patchExt = { match: { ext: '.css' } };
assert(_testing.patchMatches(patchExt, mockAsset('any', 'path/to/style.css')), 'ext match .css');
assert(!_testing.patchMatches(patchExt, mockAsset('any', 'script.js')), 'ext match: false for .js');

const patchExtArr = { match: { ext: ['.js', '.mjs'] } };
assert(_testing.patchMatches(patchExtArr, mockAsset('any', 'bundle.js')), 'ext array match .js');
assert(_testing.patchMatches(patchExtArr, mockAsset('any', 'bundle.mjs')), 'ext array match .mjs');
assert(!_testing.patchMatches(patchExtArr, mockAsset('any', 'style.css')), 'ext array: false for .css');

// Combined rules (AND logic)
const patchCombined = { match: { pluginPrefix: 'rcp-fe-lol-', ext: '.css' } };
assert(_testing.patchMatches(patchCombined, mockAsset('rcp-fe-lol-uikit', 'main.css')), 'combined AND: both match');
assert(!_testing.patchMatches(patchCombined, mockAsset('rcp-fe-lol-uikit', 'bundle.js')), 'combined AND: ext fails');
assert(!_testing.patchMatches(patchCombined, mockAsset('rcp-fe-plugin-runner', 'main.css')), 'combined AND: plugin fails');

// No match rules (match everything)
const patchNoMatch = {};
assert(_testing.patchMatches(patchNoMatch, mockAsset('anything', 'anything.xyz')), 'no match rules: matches everything');

// Custom match function
const patchCustom = {
  match: {
    customMatch: (asset) => asset.fileName.startsWith('champ') && asset.pluginName.includes('select')
  }
};
assert(_testing.patchMatches(patchCustom, mockAsset('rcp-fe-lol-champ-select', 'champ-select.js')), 'custom match: true');
assert(!_testing.patchMatches(patchCustom, mockAsset('rcp-fe-lol-uikit', 'champ-select.js')), 'custom match: false');

console.log(`  (match tests: ${passed} pass assertions so far)`);

// ---------------------------------------------------------------------------
// Test 3: Transform types
// ---------------------------------------------------------------------------
section('Test 3: Transform types (string mode)');

// replace
const replaceResult = fePatcher.applyTransform(
  'Hello World', { type: 'replace', find: 'World', replace: 'Rift' }
);
assert(replaceResult === 'Hello Rift', `replace: "${replaceResult}"`);

// replace with flags (global)
const replaceGlobal = fePatcher.applyTransform(
  'foo foo foo', { type: 'replace', find: 'foo', replace: 'bar', flags: 'g' }
);
assert(replaceGlobal === 'bar bar bar', `replace global: "${replaceGlobal}"`);

// regex transform
const regexResult = fePatcher.applyTransform(
  'alpha beta gamma', { type: 'regex', pattern: /(\w+)\s(\w+)\s(\w+)/, replace: '$3 $2 $1' }
);
assert(regexResult === 'gamma beta alpha', `regex: "${regexResult}"`);

// prepend
const prependResult = fePatcher.applyTransform(
  'world', { type: 'prepend', content: 'hello ' }
);
assert(prependResult === 'hello world', `prepend: "${prependResult}"`);

// append
const appendResult = fePatcher.applyTransform(
  'hello', { type: 'append', content: ' world' }
);
assert(appendResult === 'hello world', `append: "${appendResult}"`);

// prepend-once (first call inserts, second skips)
let content = 'original';
content = fePatcher.applyTransform(content, { type: 'prepend-once', marker: '// MARK', content: '// MARK\n' });
assert(content === '// MARK\noriginal', `prepend-once (first): ok`);
content = fePatcher.applyTransform(content, { type: 'prepend-once', marker: '// MARK', content: '// MARK\n' });
assert(content === '// MARK\noriginal', `prepend-once (second): no duplicate`);

// append-once
content = 'start';
content = fePatcher.applyTransform(content, { type: 'append-once', marker: '// END', content: '\n// END' });
assert(content === 'start\n// END', `append-once (first): ok`);
content = fePatcher.applyTransform(content, { type: 'append-once', marker: '// END', content: '\n// END' });
assert(content === 'start\n// END', `append-once (second): no duplicate`);

// inject-css (into HTML)
const htmlInput = '<!doctype html><html><head></head><body></body></html>';
const cssResult = fePatcher.applyTransform(htmlInput, {
  type: 'inject-css', position: 'before', content: 'body { color: red; }'
});
assert(cssResult.includes('<style data-fe-patcher>'), 'inject-css: style tag present');
assert(cssResult.includes('body { color: red; }'), 'inject-css: CSS content present');
assert(cssResult.includes('</head>'), 'inject-css: inserted before </head>');

// custom transform
const customResult = fePatcher.applyTransform('hello', {
  type: 'custom',
  fn: (str) => str.toUpperCase() + '!'
});
assert(customResult === 'HELLO!', `custom: "${customResult}"`);

console.log(`  (transform tests: accumulated)`);

// ---------------------------------------------------------------------------
// Test 4: Buffer round-trip
// ---------------------------------------------------------------------------
section('Test 4: Buffer patching');

const testBuffer = Buffer.from('const x = 1;\nconst y = 2;\n', 'utf8');
const patchedBuffer = fePatcher.applyTransform(testBuffer, {
  type: 'replace', find: 'const x = 1', replace: 'const x = 42'
});
assert(Buffer.isBuffer(patchedBuffer), 'buffer input → buffer output');
const patchedStr = patchedBuffer.toString('utf8');
assert(patchedStr.includes('const x = 42'), 'buffer content patched correctly');
assert(patchedStr.includes('const y = 2'), 'unchanged content preserved');

// Multiple transforms on buffer
const multiPatch = fePatcher.applyTransform(
  fePatcher.applyTransform(testBuffer,
    { type: 'prepend', content: '// top\n' }),
  { type: 'append', content: '// bottom\n' }
);
const multiStr = multiPatch.toString('utf8');
assert(multiStr.startsWith('// top\n'), 'multi-transform prepend on buffer');
assert(multiStr.endsWith('// bottom\n'), 'multi-transform append on buffer');

// ---------------------------------------------------------------------------
// Test 5: applyPatches full pipeline
// ---------------------------------------------------------------------------
section('Test 5: Full pipeline — applyPatches() with WAD asset');

// Simulate extracting a CSS file from a WAD
const cssBuffer = Buffer.from(`
body {
  background: #010a13;
  color: #f0e6d2;
}
.container {
  background-color: #0a1428;
}
`, 'utf8');

// Apply patches targeting rcp-fe-lol-uikit/main.css
// This should match patch 02 (uikit-dark-bg) since it's enabled
const patchedCss = fePatcher.applyPatches(
  'rcp-fe-lol-uikit',
  'main.css',
  cssBuffer,
  PATCHES_DIR
);

const patchedCssStr = patchedCss.toString('utf8');
console.log('  Original CSS size:', cssBuffer.length, 'bytes');
console.log('  Patched CSS size:', patchedCss.length, 'bytes');

// Check that our prepend-once content was added
assert(
  patchedCssStr.includes('/* FE-PATCHER:dark-bg */'),
  'full pipeline: prepend-once marker found in patched CSS'
);
assert(
  patchedCssStr.includes('background: #050d1a !important'),
  'full pipeline: injected CSS rule present'
);

// Test that unmatched assets pass through unchanged
const jsBuffer = Buffer.from('console.log("hello");', 'utf8');
const unpatchedJs = fePatcher.applyPatches(
  'rcp-fe-lol-uikit',
  'bundle.js',
  jsBuffer,
  PATCHES_DIR
);
assert(unpatchedJs.toString('utf8') === 'console.log("hello");', 'unmatched asset passes through unchanged');

// ---------------------------------------------------------------------------
// Test 6: HTML patching
// ---------------------------------------------------------------------------
section('Test 6: HTML patching');

// Load only HTML-targeted patches
const htmlPatches = patches.filter(p => (p.target === 'html') && p.enabled !== false);
assert(htmlPatches.length > 0, 'Found HTML patch(es)');

// Use the patchHtml function which filters for 'html' target
const originalHtml = '<!doctype html><html><head></head><body><h1>Starting Electron League Client</h1></body></html>';
const patchedHtml = fePatcher.patchHtml(originalHtml, PATCHES_DIR);

assert(patchedHtml.includes('Patched Electron League Client'), 'HTML: title text replaced');
assert(patchedHtml.includes('.patch-indicator'), 'HTML: CSS class injected');
assert(patchedHtml.includes('PATCHED v1.0'), 'HTML: patch indicator appended');

console.log('  Patched HTML snippet:');
console.log('  ' + patchedHtml.replace(/\n+/g, '\\n').slice(0, 200) + '...');

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------
section('Results');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.error('\n  SOME TESTS FAILED!');
  process.exit(1);
} else {
  console.log('\n  ✓ All tests passed. Patcher system works correctly.\n');
  process.exit(0);
}
