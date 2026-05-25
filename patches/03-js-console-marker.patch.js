/**
 * Test Patch 3: JS injection — adds a console marker
 *
 * Targets any FE JavaScript file and injects a timestamp console.log
 * at the top. This proves JS patching works on WAD-extracted assets.
 *
 * The "prepend-once" transform uses a marker string to avoid double-patching
 * when the same file is served multiple times.
 */

// target: "asset" — modifies WAD-extracted JS files on-the-fly
module.exports = {
  id: "js-console-marker",
  description: "Injects a console.log marker into all FE JavaScript files",
  target: "asset",
  enabled: false, // Disabled by default; enable to test JS patching

  match: {
    ext: ".js",
    pluginPrefix: "rcp-fe-",
  },

  transforms: [
    {
      type: "prepend-once",
      marker: "// FE-PATCHER",
      content: `// FE-PATCHER:js-console-marker\n;(function(){console.log('%c[PATCHED] %c' + new Date().toISOString(),'color:#c8aa6e','color:#aaa')})();\n`,
    }
  ]
};
