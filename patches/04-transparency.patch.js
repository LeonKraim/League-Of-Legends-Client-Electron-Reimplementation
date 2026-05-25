/**
 * Test Patch 4: Wildcard CSS modifier for all frontend plugins
 *
 * Attempts to inject a subtle transparency effect into any CSS file.
 * Uses regex-based matching against common CSS patterns.
 */

// target: "asset" — modifies WAD-extracted CSS files on-the-fly
module.exports = {
  id: "global-css-subtle-transparency",
  description: "Makes all CSS loaded panels slightly transparent",
  target: "asset",
  enabled: false, // Disabled by default — enable for testing

  match: {
    ext: ".css",
    pluginPrefix: "rcp-fe-",
  },

  transforms: [
    {
      type: "regex",
      pattern: /background\s*:\s*(#[0-9a-fA-F]{6}|rgba?\([^)]+\))/gi,
      replace: (match, color) => {
        // Only modify hex colors, leave rgba alone
        if (color.startsWith('#')) {
          return `background: ${color}ee`;
        }
        return match;
      },
    }
  ]
};
