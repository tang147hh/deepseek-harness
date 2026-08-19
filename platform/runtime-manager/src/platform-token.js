"use strict";

// Local: load the single implementation. Docker overwrites this file with
// control-plane/src/platform-token.js so the image does not need the sibling tree.
module.exports = require("../../control-plane/src/platform-token");
