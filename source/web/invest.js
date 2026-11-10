// =====================================================================================================
// TimeVault invest guard: the weekly buy of BTC and ETH on Arbitrum One.
// Kept apart from core.js on purpose. core.js (the lock guard) is unchanged and still never approves anything.
// No new contract: the swap goes through Uniswap's own SwapRouter02 and the coins go straight to YOUR wallet.
//
// This guard can send only two kinds of transaction, and it builds the bytes itself:
//   approve : USDC or USDT approve(Uniswap SwapRouter02, exactly this buy's amount). Never an unlimited approval.
//   buy     : SwapRouter02.multicall(deadline, calls) where calls are only
//               exactInput(USDC/USDT -> ... -> WBTC, recipient = YOUR wallet)
//               exactInput(USDC/USDT -> ... -> WETH, recipient = the router itself), then unwrapWETH9(min, YOUR wallet)
// Before asking the wallet it checks: the router, quoter, coins and price feeds are the real ones (on 2+ servers),
// the Uniswap price is within 2% of Chainlink's price, and every part has a minimum it must receive or it reverts.
// =====================================================================================================
const TVI = (() => {
  'use strict';

  const A = {
    ROUTER: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',  // Uniswap SwapRouter02
    QUOTER: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',  // Uniswap QuoterV2
    FACTORY: '0x1F98431c8aD98523631AE4a59f267346ea31F984', // Uniswap V3 factory
    WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
    WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
    FEED_ETH: '0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612', // Chainlink ETH / USD
    FEED_BTC: '0x6ce185860a4963106506C203335A2910413708e9', // Chainlink BTC / USD
  };
  const ADDRESS_THIS = '0x0000000000000000000000000000000000000002'; // SwapRouter02: "keep it in the router" (for unwrapping)
  const COINS = {
    BTC: { token: A.WBTC, decimals: 8, symbol: 'WBTC', feed: A.FEED_BTC, feedName: 'BTC / USD' },
    ETH: { token: A.WETH, decimals: 18, symbol: 'WETH', feed: A.FEED_ETH, feedName: 'ETH / USD' },
  };
  const MAX_BELOW_ORACLE = 200n;  // basis points: refuse if Uniswap pays more than 2% less than Chainlink's price
  const SLIPPAGE = 50n;           // basis points: each part must get at least 99.5% of the quote, or the whole buy reverts
  const MAX_BUY = 10000;          // dollars per buy, a typo guard
  const MIN_PART = 1;             // dollars per coin
  const FEED_MAX_AGE = 26 * 3600; // Chainlink updates these at least every 24h on Arbitrum

  const ROUTER_ABI = [
    'function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])',
    'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)',
    'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
    'function WETH9() view returns (address)', 'function factory() view returns (address)',
  ];
  const QUOTER_ABI = [
    'function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
    'function WETH9() view returns (address)', 'function factory() view returns (address)',
  ];
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)',
    'event Transfer(address indexed from, address indexed to, uint256 value)'];
  const WETH_EVENTS = ['event Withdrawal(address indexed src, uint256 wad)'];
  const FEED_ABI = ['function latestRoundData() view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80)',
    'function decimals() view returns (uint8)', 'function description() view returns (string)'];

  class Refused extends Error { constructor(msg) { super(msg); this.name = 'Refused'; this.refused = true; } }
  const refuse = (m) => { throw new Refused(m); };
  const lc = (s) => String(s).toLowerCase();

  // Uniswap V3 path: token (20 bytes), fee (3 bytes), token, fee, token ...
  function encodePath(ethers, hops) {
    let out = '0x';
    for (let i = 0; i < hops.length; i++) out += (i % 2 ? ethers.toBeHex(hops[i], 3) : ethers.getAddress(hops[i])).slice(2).toLowerCase();
    return out;
  }
  function decodePath(ethers, path) {
    const h = path.slice(2), out = []; let i = 0;
    while (true) {
      out.push(ethers.getAddress('0x' + h.slice(i, i + 40))); i += 40;
      if (i >= h.length) break;
      out.push(parseInt(h.slice(i, i + 6), 16)); i += 6;
    }
    if (i !== h.length) refuse('Internal check failed: bad swap route. Stopped.');
    return out;
  }
  // Routes worth trying for one coin. The best quote wins.
  function candidates(input, target, usdc) {
    const r = [[input, 500, target], [input, 3000, target], [input, 100, target]];
    if (lc(target) !== lc(A.WETH)) r.push([input, 500, A.WETH, 500, target], [input, 500, A.WETH, 3000, target]);
    if (lc(input) !== lc(usdc)) r.push([input, 100, usdc, 500, target]);
    return r;
  }

  async function quorum(providers, fn, need, label) {
    const res = await Promise.allSettled(providers.map((p) => fn(p)));
    const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (ok.length < need) refuse('Could not reach enough Arbitrum servers to double-check ' + label + '. Nothing was sent. Try again in a minute.');
    const s = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x));
    for (const v of ok) if (s(v) !== s(ok[0])) refuse('Arbitrum servers disagree about ' + label + '. Stopping to be safe. Nothing was sent.');
    return ok[0];
  }

  // cfg: { providers, need, tokens: {USDC:{address,decimals}, USDT:{...}}, chainId, maxBaseFee, getAccount, getSigner,
  //        onAsk(summary) -> Promise<bool>, onSent(hash, summary), now?: () => seconds }
  function makeInvestor(ethers, cfg) {
    const main = cfg.providers[0];
    const allowedIn = Object.fromEntries(Object.entries(cfg.tokens).map(([k, v]) => [lc(v.address), k]));
    const known = new Set([A.WETH, A.WBTC, ...Object.values(cfg.tokens).map((t) => t.address)].map(lc));
    const R = new ethers.Interface(ROUTER_ABI), E = new ethers.Interface(ERC20_ABI), W = new ethers.Interface(WETH_EVENTS);

    // The router, quoter, coins and price feeds must be what we expect, according to every server that answers.
    async function checkSetup() {
      await quorum(cfg.providers, async (p) => {
        const r = new ethers.Contract(A.ROUTER, ROUTER_ABI, p), q = new ethers.Contract(A.QUOTER, QUOTER_ABI, p);
        const out = { rw: await r.WETH9(), rf: await r.factory(), qw: await q.WETH9(), qf: await q.factory() };
        for (const [k, c] of Object.entries(COINS)) {
          const t = new ethers.Contract(c.token, ERC20_ABI, p), f = new ethers.Contract(c.feed, FEED_ABI, p);
          out[k] = [await t.symbol(), Number(await t.decimals()), Number(await f.decimals()), await f.description()];
        }
        return out;
      }, cfg.need, 'the exchange').then((o) => {
        if (lc(o.rw) !== lc(A.WETH) || lc(o.rf) !== lc(A.FACTORY) || lc(o.qw) !== lc(A.WETH) || lc(o.qf) !== lc(A.FACTORY)) refuse('The Uniswap contracts on this network look wrong. Nothing was sent.');
        for (const [k, c] of Object.entries(COINS)) {
          const [sym, dec, fdec, desc] = o[k];
          if (sym !== c.symbol || dec !== c.decimals) refuse('The ' + k + ' coin contract looks wrong. Nothing was sent.');
          if (fdec !== 8 || desc !== c.feedName) refuse('The ' + k + ' price feed looks wrong. Nothing was sent.');
        }
      });
    }

    // Chainlink price in dollars with 8 decimals, agreed by 2+ servers and fresh.
    async function oracle(coin, nowTs) {
      const c = COINS[coin];
      const [answer, updatedAt] = await quorum(cfg.providers, async (p) => { const r = await new ethers.Contract(c.feed, FEED_ABI, p).latestRoundData(); return [r[1], r[3]]; }, cfg.need, 'the ' + coin + ' price');
      if (answer <= 0n) refuse('The ' + coin + ' price feed returned no price. Nothing was sent.');
      if (nowTs - Number(updatedAt) > FEED_MAX_AGE) refuse('The ' + coin + ' price feed is out of date. Nothing was sent. Try again later.');
      return answer;
    }
    async function bestQuote(input, coin, amountIn) {
      const q = new ethers.Contract(A.QUOTER, QUOTER_ABI, main);
      let best = null;
      for (const hops of candidates(input, COINS[coin].token, cfg.tokens.USDC.address)) {
        const path = encodePath(ethers, hops);
        try { const r = await q.quoteExactInput.staticCall(path, amountIn); if (!best || r[0] > best.out) best = { path, hops, out: r[0] }; } catch { /* no such pool */ }
      }
      if (!best) refuse('Uniswap has no route for ' + coin + ' right now. Nothing was sent.');
      return best;
    }

    // Works out the buy without sending anything: amounts, routes, price checks, minimums.
    // plan: { pay: 'USDC'|'USDT', parts: { BTC: dollars, ETH: dollars } }
    async function prepare(plan) {
      const t = cfg.tokens[plan.pay]; if (!t) refuse('Pay with USDC or USDT.');
      const parts = Object.entries(plan.parts || {}).filter(([, v]) => Number(v) > 0);
      if (!parts.length) refuse('Nothing to buy. Set your weekly amount and mix first.');
      for (const [k, v] of parts) {
        if (!COINS[k]) refuse('Only BTC and ETH can be bought on Arbitrum here.');
        if (!(Number(v) >= MIN_PART)) refuse('Each coin needs at least $' + MIN_PART + '.');
      }
      const total = parts.reduce((s, [, v]) => s + Number(v), 0);
      if (total > MAX_BUY) refuse('That is more than $' + MAX_BUY + ' in one buy. Check the amount.');
      await checkSetup();
      const nowTs = cfg.now ? await cfg.now() : Number((await main.getBlock('latest')).timestamp);
      const legs = [];
      for (const [coin, usd] of parts) {
        const amountIn = ethers.parseUnits(Number(usd).toFixed(2), t.decimals);
        const [price, q] = await Promise.all([oracle(coin, nowTs), bestQuote(t.address, coin, amountIn)]);
        const c = COINS[coin];
        // what Chainlink says the dollars should buy (stablecoin counted as $1)
        const fair = amountIn * 10n ** BigInt(c.decimals) * 10n ** 8n / (price * 10n ** BigInt(t.decimals));
        if (q.out * 10000n < fair * (10000n - MAX_BELOW_ORACLE)) refuse('Uniswap\'s ' + coin + ' price is more than 2% worse than the market price right now. Nothing was sent. Try again later.');
        legs.push({ coin, usd: Number(usd), amountIn, path: q.path, hops: q.hops, quote: q.out, min: q.out * (10000n - SLIPPAGE) / 10000n, price });
      }
      return { pay: plan.pay, token: t, legs, total: legs.reduce((s, l) => s + l.amountIn, 0n), nowTs };
    }

    function buildBuy(p, account, deadline) {
      const calls = [];
      for (const l of p.legs) {
        const toRouter = l.coin === 'ETH';
        calls.push(R.encodeFunctionData('exactInput', [{ path: l.path, recipient: toRouter ? ADDRESS_THIS : account, amountIn: l.amountIn, amountOutMinimum: l.min }]));
        if (toRouter) calls.push(R.encodeFunctionData('unwrapWETH9', [l.min, account]));
      }
      return R.encodeFunctionData('multicall', [deadline, calls]);
    }

    // Reads the bytes back and checks every rule in the header comment. The last word before the wallet.
    function checkBuy(data, p, account) {
      const top = R.parseTransaction({ data });
      if (!top || top.name !== 'multicall' || top.signature !== 'multicall(uint256,bytes[])') refuse('Internal check failed: unexpected call. Stopped.');
      let spent = 0n, wethOwed = 0n, unwrapped = false;
      for (const raw of top.args[1]) {
        const c = R.parseTransaction({ data: raw });
        if (c && c.name === 'exactInput') {
          if (unwrapped) refuse('Internal check failed: swap after unwrap. Stopped.');
          const [path, recipient, amountIn, minOut] = c.args[0];
          const hops = decodePath(ethers, path);
          if (lc(hops[0]) !== lc(p.token.address)) refuse('Internal check failed: wrong coin paid in. Stopped.');
          for (let i = 0; i < hops.length; i += 2) if (!known.has(lc(hops[i]))) refuse('Internal check failed: unknown coin in route. Stopped.');
          const end = lc(hops[hops.length - 1]);
          if (end === lc(A.WBTC)) { if (lc(recipient) !== lc(account)) refuse('Internal check failed: BTC not paid to your wallet. Stopped.'); }
          else if (end === lc(A.WETH)) { if (lc(recipient) !== lc(ADDRESS_THIS)) refuse('Internal check failed: ETH route. Stopped.'); wethOwed += minOut; }
          else refuse('Internal check failed: unknown coin bought. Stopped.');
          if (minOut <= 0n) refuse('Internal check failed: no minimum. Stopped.');
          spent += amountIn;
        } else if (c && c.signature === 'unwrapWETH9(uint256,address)') {
          if (lc(c.args[1]) !== lc(account) || c.args[0] !== wethOwed || unwrapped) refuse('Internal check failed: ETH not paid to your wallet. Stopped.');
          unwrapped = true;
        } else refuse('Internal check failed: unexpected call inside the buy. Stopped.');
      }
      if (wethOwed > 0n && !unwrapped) refuse('Internal check failed: ETH left in the router. Stopped.');
      if (spent !== p.total) refuse('Internal check failed: amount mismatch. Stopped.');
    }

    async function signerChecks(signer, account) {
      if (lc(cfg.getAccount()) !== lc(account) || lc(await signer.getAddress()) !== lc(account)) refuse('Wallet account changed. Reconnect and try again.');
      if (Number(await signer.provider.send('eth_chainId', [])) !== cfg.chainId) refuse('Your wallet is not on Arbitrum One. Switch networks and try again. Nothing was sent.');
    }
    async function fees() {
      const base = (await main.getBlock('latest')).baseFeePerGas ?? 0n;
      if (cfg.maxBaseFee && base > cfg.maxBaseFee) refuse('Network fees look abnormally high right now. Nothing was sent. Try again later.');
      let cap = base * 3n; const floor = ethers.parseUnits('0.1', 'gwei'); if (cap < floor) cap = floor;
      return { maxFeePerGas: cap, maxPriorityFeePerGas: 0n };
    }
    async function waitReceipt(hash) {
      for (let i = 0; i < 300; i++) { const rc = await main.getTransactionReceipt(hash).catch(() => null); if (rc) return rc; await new Promise((r) => setTimeout(r, 1000)); }
      throw new Error('Timed out waiting for the transaction. Check your wallet history before trying again.');
    }
    async function sendTx(signer, account, tx, summary) {
      if (!(lc(tx.to) === lc(A.ROUTER) || allowedIn[lc(tx.to)])) refuse('Internal check failed: unexpected destination. Stopped.');
      if (allowedIn[lc(tx.to)]) { const c = E.parseTransaction({ data: tx.data }); if (!c || c.name !== 'approve' || lc(c.args[0]) !== lc(A.ROUTER) || c.args[1] > ethers.parseUnits(String(MAX_BUY), 6)) refuse('Internal check failed: unexpected approval. Stopped.'); }
      // dry run with the exact bytes, from your address, against the live chain
      try { await main.call({ from: account, to: tx.to, data: tx.data, value: 0n }); }
      catch (e) { refuse('Dry run failed, so nothing was sent: ' + (e.reason || e.shortMessage || e.message || e).toString().slice(0, 160)); }
      let gasLimit;
      try { gasLimit = (await main.estimateGas({ from: account, to: tx.to, data: tx.data, value: 0n })) * 13n / 10n; } catch { gasLimit = 2_000_000n; }
      if (gasLimit > 5_000_000n) refuse('Unexpected gas use. Stopped.');
      if (cfg.onAsk && !(await cfg.onAsk(summary))) refuse('Cancelled.');
      await signerChecks(signer, account);
      const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n, gasLimit, chainId: BigInt(cfg.chainId), ...(await fees()) });
      if (cfg.onSent) { try { cfg.onSent(sent.hash, summary); } catch {} }
      const rc = await waitReceipt(sent.hash);
      if (!rc || rc.status !== 1) throw new Error('The transaction failed on chain. ' + (summary.failNote || ''));
      return rc;
    }

    // The weekly buy. Up to two wallet requests: approve this exact amount (skipped if already approved), then the buy.
    async function buy(plan, onStep) {
      const account = cfg.getAccount(); if (!account) refuse('Connect your wallet first.');
      const signer = await cfg.getSigner(); await signerChecks(signer, account);
      onStep && onStep('check');
      const p = await prepare(plan);
      const erc = new ethers.Contract(p.token.address, ERC20_ABI, main);
      if ((await erc.balanceOf(account)) < p.total) refuse('Your wallet has less than ' + ethers.formatUnits(p.total, p.token.decimals) + ' ' + p.pay + '.');
      const amt = ethers.formatUnits(p.total, p.token.decimals) + ' ' + p.pay;
      if ((await erc.allowance(account, A.ROUTER)) < p.total) {
        onStep && onStep('approve');
        await sendTx(signer, account, { to: p.token.address, data: E.encodeFunctionData('approve', [A.ROUTER, p.total]) }, {
          action: 'approve', to: p.token.address, spender: A.ROUTER,
          text: 'Let Uniswap\'s swap router use exactly ' + amt + ' for this week\'s buy. Nothing else, and no coins move in this step.',
          failNote: 'Your coins are still in your wallet.',
        });
      }
      // fresh prices right before the buy, since the approval may have taken a while
      const fresh = await prepare(plan);
      if (fresh.total !== p.total) refuse('Internal check failed: amount changed. Stopped.');
      const deadline = BigInt(fresh.nowTs + 20 * 60);
      const data = buildBuy(fresh, account, deadline);
      checkBuy(data, fresh, account);
      onStep && onStep('buy');
      const rc = await sendTx(signer, account, { to: A.ROUTER, data }, {
        action: 'buy', to: A.ROUTER, legs: fresh.legs.map((l) => ({ coin: l.coin, usd: l.usd, min: ethers.formatUnits(l.min, COINS[l.coin].decimals) })),
        text: 'Swap ' + amt + ' on Uniswap. ' + fresh.legs.map((l) => (l.coin === 'BTC' ? 'At least ' + ethers.formatUnits(l.min, 8) + ' WBTC' : 'At least ' + Number(ethers.formatEther(l.min)).toFixed(6) + ' ETH')).join(' and ') + ' to your wallet ' + account + ', or the swap cancels itself.',
        failNote: 'Your ' + p.pay + ' is still in your wallet.',
      });
      // what actually arrived, read from the receipt
      const got = { BTC: 0n, ETH: 0n };
      for (const log of rc.logs || []) {
        if (lc(log.address) === lc(A.WBTC)) { try { const ev = E.parseLog(log); if (ev && ev.name === 'Transfer' && lc(ev.args.to) === lc(account)) got.BTC += ev.args.value; } catch {} }
        if (lc(log.address) === lc(A.WETH)) { try { const ev = W.parseLog(log); if (ev && ev.name === 'Withdrawal' && lc(ev.args.src) === lc(A.ROUTER)) got.ETH += ev.args.wad; } catch {} }
      }
      return { hash: rc.hash, pay: p.pay, legs: fresh.legs.map((l) => ({ coin: l.coin, usd: l.usd, amount: ethers.formatUnits(got[l.coin], COINS[l.coin].decimals) })) };
    }

    // Prices for the screens only (never used to send anything): Chainlink, from the first server that answers.
    async function prices() {
      const out = {};
      for (const [k, c] of Object.entries(COINS)) {
        for (const p of cfg.providers) { try { out[k] = Number((await new ethers.Contract(c.feed, FEED_ABI, p).latestRoundData())[1]) / 1e8; break; } catch {} }
      }
      return out;
    }
    async function holdings(who) {
      const out = {};
      for (const p of cfg.providers) {
        try { out.BTC = Number(ethers.formatUnits(await new ethers.Contract(A.WBTC, ERC20_ABI, p).balanceOf(who), 8)); out.ETH = Number(ethers.formatEther(await p.getBalance(who))); return out; } catch {}
      }
      return out;
    }

    return Object.freeze({ prepare, buildBuy, checkBuy, buy, prices, holdings });
  }

  return Object.freeze({ A, ADDRESS_THIS, COINS, encodePath, decodePath, candidates, makeInvestor, Refused });
})();
