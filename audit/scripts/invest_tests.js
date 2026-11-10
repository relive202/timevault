// Tests for the invest guard (source/web/invest.js) against a simulated Arbitrum: fake servers, fake Uniswap, fake wallet.
// Checks the exact transactions it would hand to the wallet, and that it refuses everything outside its rules.
const fs = require('fs'), path = require('path'), ethers = require('ethers');
const TVI = new Function('ethers', fs.readFileSync(path.join(__dirname, '..', '..', 'source', 'web', 'invest.js'), 'utf8') + '\nreturn TVI;')(ethers);
const { A, ADDRESS_THIS } = TVI;
const USDC = '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', USDT = '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9';
const TOKENS = { USDC: { address: USDC, decimals: 6 }, USDT: { address: USDT, decimals: 6 } };
const ME = '0x1111111111111111111111111111111111111111', EVIL = '0x9999999999999999999999999999999999999999';
const lc = (s) => String(s).toLowerCase();

const iface = new ethers.Interface([
  'function WETH9() view returns (address)', 'function factory() view returns (address)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)',
  'function description() view returns (string)', 'function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)',
  'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] a, uint32[] b, uint256 c)',
  'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function sweepToken(address token, uint256 amountMinimum, address recipient) payable',
  'event Transfer(address indexed from, address indexed to, uint256 value)', 'event Withdrawal(address indexed src, uint256 wad)',
]);

// world state for the simulated chain
function world(over = {}) {
  return Object.assign({ eth: 3000, btc: 60000, poolCut: 0.003, now: 1_800_000_000, feedAge: 600, routerWeth: A.WETH, wbtcSym: 'WBTC', usdcBal: 1000n * 10n ** 6n, allowance: 0n, lie: false }, over);
}
function makeProvider(w, idx) {
  const enc = (fn, vals) => iface.encodeFunctionResult(fn, vals);
  const pool = (hops, amountIn) => { // value conversion along the route at oracle price minus a cut per hop
    let usd = 0, amt = Number(amountIn);
    const price = { [lc(USDC)]: [1, 6], [lc(USDT)]: [1, 6], [lc(A.WETH)]: [w.eth, 18], [lc(A.WBTC)]: [w.btc, 8] };
    const [p0, d0] = price[lc(hops[0])]; usd = amt / 10 ** d0 * p0;
    for (let i = 2; i < hops.length; i += 2) usd *= 1 - w.poolCut;
    if (hops[1] === 100 && hops.length === 3 && lc(hops[2]) !== lc(USDC)) throw new Error('no pool');
    const [p1, d1] = price[lc(hops[hops.length - 1])]; return BigInt(Math.floor(usd / p1 * 10 ** d1));
  };
  return {
    async call(tx) {
      const to = lc(tx.to), d = iface.parseTransaction({ data: tx.data }), n = d.name;
      if (n === 'WETH9') return enc(n, [to === lc(A.ROUTER) ? w.routerWeth : A.WETH]);
      if (n === 'factory') return enc(n, [A.FACTORY]);
      if (n === 'symbol') return enc(n, [to === lc(A.WBTC) ? w.wbtcSym : 'WETH']);
      if (n === 'decimals') return enc(n, [to === lc(A.WBTC) ? 8 : to === lc(A.WETH) ? 18 : 8]);
      if (n === 'description') return enc(n, [to === lc(A.FEED_BTC) ? 'BTC / USD' : 'ETH / USD']);
      if (n === 'latestRoundData') return enc(n, [1, BigInt(Math.round((to === lc(A.FEED_BTC) ? w.btc : w.eth) * (w.lie && idx === 1 ? 1.1 : 1) * 1e8)), 0, w.now - w.feedAge, 1]);
      if (n === 'balanceOf') return enc(n, [w.usdcBal]);
      if (n === 'allowance') return enc(n, [w.allowance]);
      if (n === 'quoteExactInput') return enc(n, [pool(TVI.decodePath(ethers, d.args[0]), d.args[1]), [], [], 0]);
      return '0x'; // dry runs of approve / multicall succeed
    },
    async getBlock() { return { timestamp: w.now, baseFeePerGas: 10_000_000n }; },
    async getBalance() { return 10n ** 16n; },
    async estimateGas() { return 300_000n; },
    async getTransactionReceipt(h) { return w.receipts[h] || null; },
  };
}
function setup(over) {
  const w = world(over); w.receipts = {}; w.sent = [];
  const providers = [0, 1, 2].map((i) => makeProvider(w, i));
  const signer = {
    async getAddress() { return ME; }, provider: { async send() { return '0xa4b1'; } },
    async sendTransaction(tx) {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(String(w.sent.length))); w.sent.push(tx);
      const logs = [];
      const d = iface.parseTransaction({ data: tx.data });
      if (d.name === 'multicall') for (const raw of d.args[1]) {
        const c = iface.parseTransaction({ data: raw });
        if (c.name === 'exactInput' && lc(c.args[0][1]) === lc(ME)) logs.push({ address: A.WBTC, ...iface.encodeEventLog('Transfer', [A.ROUTER, ME, c.args[0][3] + 5n]) });
        if (c.name === 'unwrapWETH9') logs.push({ address: A.WETH, ...iface.encodeEventLog('Withdrawal', [A.ROUTER, c.args[0] + 7n]) });
      }
      w.receipts[hash] = { status: 1, hash, logs }; return { hash };
    },
  };
  const asked = [];
  const inv = TVI.makeInvestor(ethers, { providers, need: 2, tokens: TOKENS, chainId: 42161, maxBaseFee: ethers.parseUnits('2', 'gwei'), getAccount: () => ME, getSigner: async () => signer, onAsk: async (s) => { asked.push(s); return true; } });
  return { w, inv, asked };
}

let pass = 0, fail = 0;
async function t(name, fn) { try { await fn(); pass++; console.log('PASS ' + name); } catch (e) { fail++; console.log('FAIL ' + name + ': ' + (e.stack || e)); } }
const must = (c, m) => { if (!c) throw new Error(m); };
async function refuses(fn, re) { try { await fn(); } catch (e) { must(e.refused, 'expected a refusal, got: ' + e.message); must(!re || re.test(e.message), 'wrong reason: ' + e.message); return; } throw new Error('was not refused'); }

(async () => {
  await t('route encoding round trip', () => {
    const hops = [USDC, 500, A.WETH, 3000, A.WBTC], p = TVI.encodePath(ethers, hops);
    must(p.length === 2 + 2 * (20 * 3 + 3 * 2), 'length'); must(JSON.stringify(TVI.decodePath(ethers, p)) === JSON.stringify([ethers.getAddress(USDC), 500, A.WETH, 3000, A.WBTC]), 'decode');
  });
  await t('weekly buy: approves exactly the amount, then one swap paying only my wallet', async () => {
    const { w, inv, asked } = setup();
    const r = await inv.buy({ pay: 'USDC', parts: { BTC: 20, ETH: 9.5 } });
    must(w.sent.length === 2, 'two transactions, got ' + w.sent.length);
    const [ap, buy] = w.sent;
    must(lc(ap.to) === lc(USDC) && BigInt(ap.value) === 0n, 'approve goes to USDC');
    const a = iface.parseTransaction({ data: ap.data }); must(a.name === 'approve' && lc(a.args[0]) === lc(A.ROUTER) && a.args[1] === 29_500_000n, 'exact approval to the router');
    must(lc(buy.to) === lc(A.ROUTER) && BigInt(buy.value) === 0n && buy.chainId === 42161n, 'swap goes to the router with no ETH, on Arbitrum');
    const m = iface.parseTransaction({ data: buy.data }); must(m.name === 'multicall' && m.args[0] === BigInt(w.now + 1200), 'multicall with a 20 minute deadline');
    const calls = m.args[1].map((x) => iface.parseTransaction({ data: x }));
    must(calls.map((c) => c.name).join() === 'exactInput,exactInput,unwrapWETH9', 'calls: ' + calls.map((c) => c.name));
    const [b, e, u] = calls;
    must(lc(b.args[0][1]) === lc(ME) && b.args[0][2] === 20_000_000n, 'BTC paid to me');
    must(lc(TVI.decodePath(ethers, b.args[0][0]).at(-1)) === lc(A.WBTC), 'BTC route ends in WBTC');
    must(lc(e.args[0][1]) === lc(ADDRESS_THIS) && e.args[0][2] === 9_500_000n, 'ETH kept in router for unwrapping');
    must(lc(u.args[1]) === lc(ME) && u.args[0] === e.args[0][3], 'ETH unwrapped to me with the same minimum');
    const fairBtc = 20 / 60000 * 1e8; must(Number(b.args[0][3]) > fairBtc * 0.98, 'BTC minimum is close to the market price');
    must(asked.map((s) => s.action).join() === 'approve,buy', 'confirm screen shown before each');
    must(r.legs.length === 2 && Number(r.legs[0].amount) > 0 && Number(r.legs[1].amount) > 0, 'amounts read from receipt');
  });
  await t('no second approval when this amount is already approved', async () => {
    const { w, inv } = setup({ allowance: 50n * 10n ** 6n });
    await inv.buy({ pay: 'USDC', parts: { BTC: 20, ETH: 10 } }); must(w.sent.length === 1, 'only the swap');
  });
  await t('pays with USDT when asked', async () => {
    const { w, inv } = setup();
    await inv.buy({ pay: 'USDT', parts: { ETH: 10 } });
    must(lc(w.sent[0].to) === lc(USDT), 'approval on USDT');
    const c = iface.parseTransaction({ data: iface.parseTransaction({ data: w.sent[1].data }).args[1][0] });
    must(lc(TVI.decodePath(ethers, c.args[0][0])[0]) === lc(USDT), 'route starts with USDT');
  });
  await t('refuses when Uniswap is more than 2% worse than Chainlink', async () => {
    const { w, inv } = setup({ poolCut: 0.03 });
    await refuses(() => inv.buy({ pay: 'USDC', parts: { BTC: 20 } }), /2% worse/); must(w.sent.length === 0, 'nothing sent');
  });
  await t('refuses a stale price feed', async () => { const { w, inv } = setup({ feedAge: 30 * 3600 }); await refuses(() => inv.buy({ pay: 'USDC', parts: { ETH: 10 } }), /out of date/); must(w.sent.length === 0, 'nothing sent'); });
  await t('refuses a wrong router', async () => { const { w, inv } = setup({ routerWeth: EVIL }); await refuses(() => inv.buy({ pay: 'USDC', parts: { ETH: 10 } }), /Uniswap contracts/); must(w.sent.length === 0, 'nothing sent'); });
  await t('refuses a fake WBTC', async () => { const { inv } = setup({ wbtcSym: 'WBTC2' }); await refuses(() => inv.buy({ pay: 'USDC', parts: { BTC: 10 } }), /coin contract/); });
  await t('refuses when servers disagree on the price', async () => { const { inv } = setup({ lie: true }); await refuses(() => inv.buy({ pay: 'USDC', parts: { ETH: 10 } }), /disagree/); });
  await t('refuses more than the wallet holds', async () => { const { w, inv } = setup({ usdcBal: 5n * 10n ** 6n }); await refuses(() => inv.buy({ pay: 'USDC', parts: { ETH: 10 } }), /less than/); must(w.sent.length === 0, 'nothing sent'); });
  await t('refuses SOL, tiny parts, huge buys and unknown coins', async () => {
    const { inv } = setup();
    await refuses(() => inv.buy({ pay: 'USDC', parts: { SOL: 10 } }), /Only BTC and ETH/);
    await refuses(() => inv.buy({ pay: 'USDC', parts: { BTC: 0.5 } }), /at least/);
    await refuses(() => inv.buy({ pay: 'USDC', parts: { BTC: 9000, ETH: 2000 } }), /more than/);
    await refuses(() => inv.buy({ pay: 'DAI', parts: { BTC: 10 } }), /USDC or USDT/);
    await refuses(() => inv.buy({ pay: 'USDC', parts: {} }), /Nothing to buy/);
  });
  await t('the final check rejects tampered swaps', async () => {
    const { inv } = setup();
    const p = await inv.prepare({ pay: 'USDC', parts: { BTC: 20, ETH: 10 } });
    const good = inv.buildBuy(p, ME, 1n); inv.checkBuy(good, p, ME);
    const [b, e] = p.legs;
    const ex = (l, to, min = l.min, amt = l.amountIn, path = l.path) => iface.encodeFunctionData('exactInput', [{ path, recipient: to, amountIn: amt, amountOutMinimum: min }]);
    const mc = (calls) => iface.encodeFunctionData('multicall', [1n, calls]);
    const un = (min, to) => iface.encodeFunctionData('unwrapWETH9', [min, to]);
    const bad = {
      'BTC to someone else': mc([ex(b, EVIL), ex(e, ADDRESS_THIS), un(e.min, ME)]),
      'ETH unwrapped to someone else': mc([ex(b, ME), ex(e, ADDRESS_THIS), un(e.min, EVIL)]),
      'ETH left in the router': mc([ex(b, ME), ex(e, ADDRESS_THIS)]),
      'ETH paid as WETH to someone else': mc([ex(b, ME), ex(e, EVIL)]),
      'no minimum': mc([ex(b, ME, 0n), ex(e, ADDRESS_THIS), un(e.min, ME)]),
      'more money than approved': mc([ex(b, ME, b.min, b.amountIn + 1n), ex(e, ADDRESS_THIS), un(e.min, ME)]),
      'extra sweep call': mc([ex(b, ME), ex(e, ADDRESS_THIS), un(e.min, ME), iface.encodeFunctionData('sweepToken', [USDC, 0n, EVIL])]),
      'unknown coin in route': mc([ex(b, ME, b.min, b.amountIn, TVI.encodePath(ethers, [USDC, 500, EVIL, 500, A.WBTC])), ex(e, ADDRESS_THIS), un(e.min, ME)]),
      'pays in a different coin': mc([ex(b, ME, b.min, b.amountIn, TVI.encodePath(ethers, [USDT, 500, A.WBTC])), ex(e, ADDRESS_THIS), un(e.min, ME)]),
      'not a multicall': ex(b, ME),
    };
    for (const [name, data] of Object.entries(bad)) { try { inv.checkBuy(data, p, ME); throw new Error('accepted: ' + name); } catch (err) { must(err.refused, name + ': ' + err.message); } }
  });
  console.log(pass + ' of ' + (pass + fail) + ' invest tests passed');
  process.exit(fail ? 1 : 0);
})();
