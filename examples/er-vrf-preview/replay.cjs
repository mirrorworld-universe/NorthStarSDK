'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');

// Pin the projection as captured. This checksum detects fixture drift; it is not a VRF proof.
const fixtureSha256 = '300756addad36d51afb5444e492ca5418738ad952af72d83409de79604c9a6ca';

function recordedCallback() {
  if (arguments.length !== 0) throw new Error('Replay cannot be bound to another request');
  const bytes = readFileSync(join(__dirname, 'recorded-callback.json'));
  if (createHash('sha256').update(bytes).digest('hex') !== fixtureSha256) {
    throw new Error('Recorded callback differs from the pinned fixture');
  }
  const recording = JSON.parse(bytes);
  const data = Buffer.from(recording.callbackDataBase64, 'base64');
  // The test consumer's callback contains an 8-byte discriminator, 32-byte request PDA and 64-byte output.
  return { ...recording, recordedOutputHex: data.subarray(40).toString('hex') };
}

module.exports = { recordedCallback };

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Usage: node replay.cjs (offline, fixed historical round; no arguments)');
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(recordedCallback(), null, 2));
  }
}
