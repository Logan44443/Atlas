'use strict';
// Same output as nanoid@2's default export (URL-safe random ids), built on
// node:crypto so no vulnerable nanoid version ships with the server.
const { randomFillSync } = require('node:crypto');

const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict';

function nanoid(size) {
  const n = Number.isInteger(size) && size > 0 ? Math.min(size, 1024) : 21;
  const bytes = randomFillSync(Buffer.alloc(n));
  let id = '';
  for (let i = 0; i < n; i++) id += ALPHABET[bytes[i] & 63];
  return id;
}

module.exports = nanoid;
module.exports.default = nanoid;
module.exports.nanoid = nanoid;
