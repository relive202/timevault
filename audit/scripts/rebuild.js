// Rebuilds both lock contracts from the source in this repository with the official compiler
// and checks the result is byte-for-byte the code the app deploys and verifies (source/*_bytecode.txt).
// Also checks the OpenZeppelin files embedded in the app are identical to the official 4.9.6 release.
const fs = require('fs'), path = require('path'), solc = require('solc');
const R = path.join(__dirname, '..', '..', 'source');
const oz = JSON.parse(fs.readFileSync(path.join(R, 'web', 'oz.json'), 'utf8'));
let bad = 0;
const say = (ok, msg) => { console.log((ok ? 'PASS ' : 'FAIL ') + msg); if (!ok) bad++; };

for (const [file, text] of Object.entries(oz)) {
  const official = fs.readFileSync(path.join(__dirname, '..', 'node_modules', file), 'utf8');
  say(official === text, 'embedded ' + file + ' is identical to the official OpenZeppelin 4.9.6 file');
}
say(solc.version().startsWith('0.8.24+commit.e11b9ed9'), 'compiler is solc ' + solc.version());
const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['evm.bytecode.object'] } } };
function build(sources, file, name) {
  const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources, settings })));
  for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
  return '0x' + out.contracts[file][name].evm.bytecode.object;
}
const goalSources = { 'GoalTimelock.sol': { content: fs.readFileSync(path.join(R, 'GoalTimelock.sol'), 'utf8') } };
for (const [k, v] of Object.entries(oz)) if (!k.endsWith('TokenTimelock.sol')) goalSources[k] = { content: v };
const dateSources = Object.fromEntries(Object.entries(oz).map(([k, v]) => [k, { content: v }]));
const gt = build(goalSources, 'GoalTimelock.sol', 'GoalTimelock');
const tt = build(dateSources, '@openzeppelin/contracts/token/ERC20/utils/TokenTimelock.sol', 'TokenTimelock');
say(gt === fs.readFileSync(path.join(R, 'gt_bytecode.txt'), 'utf8').trim(), 'goal lock rebuilt from source matches the code the app uses');
say(tt === fs.readFileSync(path.join(R, 'tt_bytecode.txt'), 'utf8').trim(), 'date lock rebuilt from source matches the code the app uses');
if (bad) { console.log(bad + ' check(s) failed'); process.exit(1); }
console.log('All rebuild checks passed.');
