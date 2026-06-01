/**
 * fe-patcher.js — On-the-fly patching engine for League FE assets.
 *
 * Patches are `.patch.js` files stored in `patches/`. Each exports a config
 * with match rules and an array of transforms. Patches are applied in-memory
 * only; no original WAD file is ever modified.
 *
 * Patch format:
 *   module.exports = {
 *     id: "my-patch",
 *     description: "what it does",
 *     enabled: true,
 *     match: { plugin, file, customMatch },
 *     transforms: [{ type, find, replace, flags }]
 *   };
 *
 * This module is required by main.js's bridge server to patch assets as they
 * are extracted from WADs. It can also patch the generated index.html.
 */

const fs = require('node:fs');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Built-in patches for generated HTML (our code, not Riot's)
// ---------------------------------------------------------------------------

const HTML_PATCHES = [];

/**
 * Register a patch for the generated index.html.
 * Called by main.js after buildIndexHtml().
 */
function addHtmlPatch(htmlPatch) {
  HTML_PATCHES.push(htmlPatch);
}

/**
 * Apply HTML patches to the generated index.html string.
 * Loads html-targeted patches from the patches/ folder.
 */
function patchHtml(html, patchesDir) {
  let result = html;

  // Apply file-based HTML patches
  if (patchesDir) {
    const filePatches = loadPatches(patchesDir, 'html');
    for (const patch of filePatches) {
      for (const transform of patch.transforms) {
        try {
          result = applyTransform(result, transform);
        } catch (err) {
          console.error(`[fe-patcher] HTML patch "${patch.id}" failed: ${err.message}`);
        }
      }
    }
  }

  // Apply programmatically-registered HTML patches
  for (const patch of HTML_PATCHES) {
    if (!patch.enabled) continue;
    for (const transform of patch.transforms) {
      try {
        result = applyTransform(result, transform);
      } catch (err) {
        console.error(`[fe-patcher] registered HTML patch "${patch.id}" failed: ${err.message}`);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// WAD asset patches (loaded from patches/ folder)
// ---------------------------------------------------------------------------

let _patches = null;
let _patchDir = null;

/**
 * Load all .patch.js files from the patches folder.
 * Returns array of patch configs (sorted by priority).
 */
function loadPatches(patchesDir, targetFilter) {
  if (_patches && _patchDir === patchesDir) {
    return targetFilter
      ? _patches.filter(p => !p.target || p.target === targetFilter)
      : _patches;
  }

  const patches = [];
  if (!fs.existsSync(patchesDir)) {
    _patches = patches;
    _patchDir = patchesDir;
    return patches;
  }

  const files = fs.readdirSync(patchesDir).filter(f => f.endsWith('.patch.js'));
  for (const file of files.sort()) {
    try {
      const mod = require(path.join(patchesDir, file));
      if (mod && mod.enabled !== false) {
        patches.push({ ...mod, _source: file });
      }
    } catch (err) {
      console.error(`[fe-patcher] failed to load patch ${file}: ${err.message}`);
    }
  }

  _patches = patches;
  _patchDir = patchesDir;
  return targetFilter
    ? patches.filter(p => !p.target || p.target === targetFilter)
    : patches;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Check if a patch matches an asset request.
 * @param {object} patch
 * @param {object} asset  { pluginName, relativePath, fileName }
 */
function patchMatches(patch, asset) {
  const m = patch.match;
  if (!m) return true; // no match rules = match everything

  // Exact plugin match
  if (m.plugin && m.plugin !== '*' && m.plugin !== asset.pluginName) return false;
  // Plugin prefix match
  if (m.pluginPrefix && !asset.pluginName.startsWith(m.pluginPrefix)) return false;

  // File name/pattern match
  if (m.file) {
    const fileName = asset.fileName || path.basename(asset.relativePath);
    if (typeof m.file === 'string') {
      if (m.file !== '*' && m.file !== fileName && m.file !== asset.relativePath) return false;
    } else if (m.file instanceof RegExp) {
      if (!m.file.test(asset.relativePath)) return false;
    }
  }

  // Extension match
  if (m.ext) {
    const ext = path.extname(asset.relativePath).toLowerCase();
    if (Array.isArray(m.ext) ? !m.ext.includes(ext) : m.ext !== ext) return false;
  }

  // Custom match function
  if (typeof m.customMatch === 'function') {
    if (!m.customMatch(asset)) return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Transform application
// ---------------------------------------------------------------------------

/**
 * Apply a single transform to a string or buffer.
 */
function applyTransform(content, transform) {
  const isBuffer = Buffer.isBuffer(content);
  let str = isBuffer ? content.toString('utf8') : String(content);

  switch (transform.type) {
    case 'replace':
      str = applyReplace(str, transform.find, transform.replace, transform.flags);
      break;

    case 'regex':
      str = applyRegex(str, transform.pattern, transform.replace, transform.flags);
      break;

    case 'regexp':
      // transform.find is a RegExp object (or string pattern)
      str = applyRegex(str, transform.find, transform.replace, transform.flags);
      break;

    case 'prepend':
      str = String(transform.content) + str;
      break;

    case 'append':
      str = str + String(transform.content);
      break;

    case 'prepend-once':
      if (!str.includes(transform.marker || transform.content)) {
        str = String(transform.content) + str;
      }
      break;

    case 'append-once':
      if (!str.includes(transform.marker || transform.content)) {
        str = str + String(transform.content);
      }
      break;

    case 'inject-css':
      // Inject a <style> or CSS rule fragment
      str = injectCss(str, transform.content, transform.position || 'before');
      break;

    case 'custom':
      if (typeof transform.fn === 'function') {
        str = transform.fn(str, content);
      }
      break;

    default:
      console.warn(`[fe-patcher] unknown transform type: ${transform.type}`);
  }

  if (isBuffer) return Buffer.from(str, 'utf8');
  return str;
}

function applyReplace(str, find, replace, flags) {
  if (typeof find === 'string') {
    if (flags && flags.includes('g')) {
      // Global string replace: escape regex chars in find string
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return str.replace(new RegExp(escaped, flags), replace);
    }
    // Single replace
    return str.replace(find, replace);
  }
  if (find instanceof RegExp) {
    return str.replace(find, replace);
  }
  console.warn('[fe-patcher] replace: find must be string or RegExp');
  return str;
}

function applyRegex(str, pattern, replace, flags) {
  if (pattern instanceof RegExp) {
    return str.replace(pattern, replace);
  }
  if (typeof pattern === 'string') {
    return str.replace(new RegExp(pattern, flags || 'g'), replace);
  }
  console.warn('[fe-patcher] regex: pattern must be string or RegExp');
  return str;
}

function injectCss(str, cssContent, position) {
  const styleTag = `<style data-fe-patcher>${cssContent}</style>`;
  const headClose = str.indexOf('</head>');

  // 'before' → insert before </head> (fallback: prepend)
  if (position === 'before') {
    if (headClose > 0) {
      return str.slice(0, headClose) + styleTag + str.slice(headClose);
    }
    return styleTag + '\n' + str;
  }

  // 'after' → insert after </head> (fallback: append)
  if (position === 'after') {
    if (headClose > 0) {
      const afterHead = headClose + '</head>'.length;
      return str.slice(0, afterHead) + '\n' + styleTag + str.slice(afterHead);
    }
    return str + '\n' + styleTag;
  }

  // 'prepend' → always at the beginning
  if (position === 'prepend') {
    return styleTag + '\n' + str;
  }

  // 'append' → always at the end
  if (position === 'append') {
    return str + '\n' + styleTag;
  }

  // Default: try before </head>, fallback to prepend
  if (headClose > 0) {
    return str.slice(0, headClose) + styleTag + str.slice(headClose);
  }
  return styleTag + '\n' + str;
}

// ---------------------------------------------------------------------------
// Main patch function
// ---------------------------------------------------------------------------

/**
 * Apply all matching patches to an asset buffer.
 *
 * @param {string} pluginName  e.g. "rcp-fe-lol-uikit"
 * @param {string} relativePath  path inside WAD, e.g. "main.css"
 * @param {Buffer} buffer  the extracted asset buffer
 * @returns {Buffer}  patched buffer (or original if no patches match)
 */
function applyPatches(pluginName, relativePath, buffer, patchesDir) {
  const patches = loadPatches(patchesDir, 'asset');
  if (!patches.length) return buffer;

  const fileName = path.basename(relativePath);
  const asset = { pluginName, relativePath, fileName };

  let result = buffer;
  let applied = false;

  for (const patch of patches) {
    if (!patchMatches(patch, asset)) continue;

    for (const transform of patch.transforms) {
      try {
        result = applyTransform(result, transform);
        applied = true;
      } catch (err) {
        console.error(`[fe-patcher] transform failed in "${patch.id}": ${err.message}`);
      }
    }

    if (applied && patch._source) {
      console.log(`[fe-patcher] applied "${patch.id}" → ${pluginName}/${relativePath}`);
    }
  }

  return result;
}

/**
 * Clear the patch cache (for testing / hot-reload).
 */
function clearCache() {
  _patches = null;
  _patchDir = null;
}

module.exports = {
  applyPatches,
  applyTransform,
  patchHtml,
  addHtmlPatch,
  loadPatches,
  clearCache,
  // Exported for testing
  _testing: {
    patchMatches,
    applyReplace,
    applyRegex,
    injectCss,
  }
};
