// =====================================================================================================
// TimeVault core. Contract code, exact-code lock verification, and the transaction guard.
// This exact file is inlined into both the app (index.html) and the test page (tests.html).
//
// THE RULE: the app never builds or sends a transaction anywhere except through TV.makeGuard().
// The guard only knows three actions, and it builds the transaction bytes itself:
//   create  : call the standard CREATE2 deployer with one of the two tested lock contracts, paying YOUR wallet
//   deposit : USDC/USDT transfer() into a lock whose on-chain code is byte-for-byte a tested lock paying YOU
//   release : release() on such a lock
// No approve(), no ETH value, no other address, no other function. Anything else is refused before the wallet
// is ever asked to sign.
// =====================================================================================================
const TV = (() => {
  'use strict';

  // Arbitrum's standard deterministic deployment proxy (the same one Foundry uses). Its code is checked before use.
  const DEPLOYER = '0x4e59b44847b379578588920cA78FbF26c0B4956C';
  const DEPLOYER_CODEHASH = '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989';
  const DEPLOYER_RUNTIME = '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3';

  // Both contracts: solc 0.8.24, optimizer on (200 runs), evmVersion paris, OpenZeppelin Contracts 4.9.6.
  // creation = full deploy code. The runtime code (what lives on chain) is the tail of it, starting at runtimeOffset.
  // slots = byte offsets inside the runtime code where the per-lock settings (immutables) are written.
  const CONTRACTS = {
    date: {
      name: 'TokenTimelock (OpenZeppelin 4.9.6, unmodified)',
      creation: '__TT_BYTECODE__',
      fingerprint: '0x29b075c113591090dc177f4c04c75fa4d97f33dcb4b479e05fc78c7138b43d07',
      runtimeOffset: 346,
      runtimeFingerprint: '0x69f0c9f615b257aa3be46f848f50fb67c4450d8eee3ec8a05bfd207cab988ec7',
      runtimeLength: 1639,
      slots: { token: [202, 386, 630], beneficiary: [83, 664], releaseTime: [159, 240] },
      ctor: ['address', 'address', 'uint256'],
    },
    goal: {
      name: 'GoalTimelock (TokenTimelock + "or balance >= goal")',
      creation: '__GT_BYTECODE__',
      fingerprint: '0x9ea0a457432e78e589fdb1dffa3bd2c2e67b2fec599fb539b9de8b81b27e9bca',
      runtimeOffset: 458,
      runtimeFingerprint: '0x821e3155e7b9b5cc0f5994c677c85ca3b72bb3e6861aec878c125f3b55331056',
      runtimeLength: 1737,
      slots: { token: [253, 293, 728], beneficiary: [94, 762], releaseTime: [215, 573], goal: [157, 531] },
      ctor: ['address', 'address', 'uint256', 'uint256'],
    },
  };

  const LOCK_ABI = [
    'function token() view returns (address)', 'function beneficiary() view returns (address)',
    'function releaseTime() view returns (uint256)', 'function goal() view returns (uint256)', 'function release()',
  ];
  const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
  const SEL_TRANSFER = '0xa9059cbb', SEL_RELEASE = '0x86d1a69f';
  const MAX_LOCK_SECONDS = 10 * 365 * 86400;

  class Refused extends Error { constructor(msg) { super(msg); this.name = 'Refused'; this.refused = true; } }
  const refuse = (msg) => { throw new Refused(msg); };
  const lc = (s) => String(s).toLowerCase();

  // ------------------------------------------------------------------------------------------- self check
  // Proves the embedded contract code is exactly the tested build, before anything else runs.
  function selfCheck(ethers) {
    const out = { ok: true, items: [] };
    const add = (label, ok) => { out.items.push({ label, ok }); if (!ok) out.ok = false; };
    for (const [kind, c] of Object.entries(CONTRACTS)) {
      add(kind + ' contract code fingerprint', ethers.keccak256(c.creation) === c.fingerprint);
      const rt = '0x' + c.creation.slice(2 + c.runtimeOffset * 2);
      add(kind + ' on-chain code template fingerprint', rt.length === 2 + c.runtimeLength * 2 && ethers.keccak256(rt) === c.runtimeFingerprint);
    }
    add('deployer code fingerprint', ethers.keccak256(DEPLOYER_RUNTIME) === DEPLOYER_CODEHASH);
    return out;
  }

  // ------------------------------------------------------------------------------------------- exact code
  function runtimeTemplate(kind) { const c = CONTRACTS[kind]; return c.creation.slice(2 + c.runtimeOffset * 2); }

  // The exact bytes a lock with these settings must have on chain.
  function expectedRuntime(ethers, kind, p) {
    const c = CONTRACTS[kind]; let h = runtimeTemplate(kind);
    const put = (starts, word) => { for (const s of starts) h = h.slice(0, s * 2) + word + h.slice(s * 2 + 64); };
    put(c.slots.token, ethers.zeroPadValue(p.token, 32).slice(2).toLowerCase());
    put(c.slots.beneficiary, ethers.zeroPadValue(p.beneficiary, 32).slice(2).toLowerCase());
    put(c.slots.releaseTime, ethers.toBeHex(p.releaseTime, 32).slice(2));
    if (kind === 'goal') put(c.slots.goal, ethers.toBeHex(p.goal, 32).slice(2));
    return '0x' + h;
  }

  function initcode(ethers, kind, p) {
    const c = CONTRACTS[kind];
    const args = kind === 'goal' ? [p.token, p.beneficiary, p.releaseTime, p.goal] : [p.token, p.beneficiary, p.releaseTime];
    return c.creation + ethers.AbiCoder.defaultAbiCoder().encode(c.ctor, args).slice(2);
  }

  // Ask several independent servers. Every server that answers must return the same thing, and at least
  // `need` must answer. A server that lies cannot make a fake lock look real unless ALL of them lie.
  async function quorum(providers, fn, need, label) {
    const res = await Promise.allSettled(providers.map((p) => fn(p)));
    const ok = res.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    if (ok.length < need) refuse('Could not reach enough Arbitrum servers to double-check ' + label + ' (' + ok.length + ' of ' + need + '). Nothing was sent. Try again in a minute.');
    const first = JSON.stringify(ok[0], (k, v) => (typeof v === 'bigint' ? v.toString() : v));
    for (const v of ok) if (JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x)) !== first) refuse('Arbitrum servers disagree about ' + label + '. Stopping to be safe. Nothing was sent.');
    return ok[0];
  }

  // Verify that `addr` is a genuine TimeVault lock. Returns its kind and settings.
  // Reads the settings, rebuilds the exact code those settings must produce, and compares byte for byte
  // with what every server reports is on chain.
  async function verifyLock(ethers, cfg, addr, expect = {}) {
    if (!ethers.isAddress(addr)) refuse('Not a valid address.');
    addr = ethers.getAddress(addr);
    const code = lc(await quorum(cfg.providers, (p) => p.getCode(addr), cfg.need, 'the lock code'));
    let kind = null;
    if (code.length === 2 + CONTRACTS.goal.runtimeLength * 2) kind = 'goal';
    else if (code.length === 2 + CONTRACTS.date.runtimeLength * 2) kind = 'date';
    else refuse('This address is not a TimeVault lock (its code does not match). Nothing was sent.');
    const p = await quorum(cfg.providers, async (prov) => {
      const c = new ethers.Contract(addr, LOCK_ABI, prov);
      const [token, beneficiary, releaseTime] = await Promise.all([c.token(), c.beneficiary(), c.releaseTime()]);
      const goal = kind === 'goal' ? await c.goal() : 0n;
      return { token: ethers.getAddress(token), beneficiary: ethers.getAddress(beneficiary), releaseTime, goal };
    }, cfg.need, 'the lock settings');
    if (code !== lc(expectedRuntime(ethers, kind, p))) refuse('This address is not a genuine TimeVault lock: its code differs from the tested code. Nothing was sent.');
    const sym = Object.keys(cfg.tokens).find((k) => lc(cfg.tokens[k].address) === lc(p.token));
    if (!sym) refuse('This lock holds a coin the app does not support. Nothing was sent.');
    if (expect.beneficiary && lc(p.beneficiary) !== lc(expect.beneficiary)) refuse('This lock pays a different wallet, not yours. Nothing was sent.');
    return { addr, kind, sym, token: p.token, beneficiary: p.beneficiary, releaseTime: Number(p.releaseTime), goal: p.goal };
  }

  // ------------------------------------------------------------------------------------------- the guard
  // cfg: { providers: [read providers, 2+ independent], need: how many must agree, tokens: {SYM:{address,decimals}},
  //        chainId, getSigner: async () => ethers Signer, getAccount: () => address, maxBaseFee (wei),
  //        onAsk(summary) -> Promise<bool> user confirmation shown BEFORE the wallet is asked }
  function makeGuard(ethers, cfg) {
    const main = cfg.providers[0];
    const now = async () => Number((await main.getBlock('latest')).timestamp);

    async function fees() {
      const blk = await main.getBlock('latest');
      const base = blk.baseFeePerGas ?? 0n;
      if (cfg.maxBaseFee && base > cfg.maxBaseFee) refuse('Network fees look abnormally high right now. Nothing was sent. Try again later.');
      let cap = base * 3n; const floor = ethers.parseUnits('0.1', 'gwei'); if (cap < floor) cap = floor;
      return { maxFeePerGas: cap, maxPriorityFeePerGas: 0n };
    }

    async function walletChecks() {
      const account = cfg.getAccount(); if (!account) refuse('Connect your wallet first.');
      const signer = await cfg.getSigner();
      if (lc(await signer.getAddress()) !== lc(account)) refuse('Wallet account changed. Reconnect and try again.');
      const chain = Number(await signer.provider.send('eth_chainId', []));
      if (chain !== cfg.chainId) refuse('Your wallet is not on Arbitrum One. Switch networks and try again. Nothing was sent.');
      return { account: ethers.getAddress(account), signer };
    }

    // The single place a transaction is handed to the wallet. Final structural check on the exact bytes.
    async function sendTx(signer, account, tx, allowedTo, summary) {
      if (tx.value !== undefined && BigInt(tx.value) !== 0n) refuse('Internal check failed: a transaction tried to send ETH. Stopped.');
      if (!allowedTo.some((a) => lc(a) === lc(tx.to))) refuse('Internal check failed: unexpected destination. Stopped.');
      // Dry run with the exact bytes, from your address, against the live chain. If it would fail, do not ask the wallet.
      try { await main.call({ from: account, to: tx.to, data: tx.data, value: 0n }); }
      catch (e) { refuse('Dry run failed, so nothing was sent: ' + (e.reason || e.shortMessage || e.message || e).toString().slice(0, 160)); }
      let gasLimit;
      try { gasLimit = (await main.estimateGas({ from: account, to: tx.to, data: tx.data, value: 0n })) * 13n / 10n; }
      catch { gasLimit = 3_000_000n; }
      if (gasLimit > 5_000_000n) refuse('Unexpected gas use. Stopped.');
      if (cfg.onAsk && !(await cfg.onAsk(summary))) refuse('Cancelled.');
      const sent = await signer.sendTransaction({ to: tx.to, data: tx.data, value: 0n, gasLimit, ...(await fees()) });
      const rc = await waitReceipt(sent.hash);
      if (!rc || rc.status !== 1) throw new Error('The transaction failed on chain. ' + (summary.failNote || ''));
      return rc;
    }

    // Poll for the receipt (included in a block). Up to 5 minutes.
    async function waitReceipt(hash) {
      for (let i = 0; i < 300; i++) {
        const rc = await main.getTransactionReceipt(hash).catch(() => null);
        if (rc) return rc;
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('Timed out waiting for the transaction. Check your wallet history before trying again.');
    }

    async function create({ kind, sym, releaseTime, goal, onStep }) {
      if (!CONTRACTS[kind]) refuse('Unknown lock type.');
      const t = cfg.tokens[sym]; if (!t) refuse('Unsupported coin.');
      const { account, signer } = await walletChecks();
      const chainNow = await now();
      releaseTime = Number(releaseTime);
      if (!(releaseTime > chainNow + 3600)) refuse('The date must be at least an hour from now.');
      if (releaseTime > chainNow + MAX_LOCK_SECONDS) refuse('The date can be at most 10 years away.');
      if (kind === 'goal') { goal = BigInt(goal); if (goal <= 0n) refuse('The goal must be more than zero.'); }
      const deployerCode = lc(await quorum(cfg.providers, (p) => p.getCode(DEPLOYER), cfg.need, 'the deployer'));
      if (ethers.keccak256(deployerCode) !== DEPLOYER_CODEHASH) refuse('The standard deployer on this network looks wrong. Nothing was sent.');
      const params = { token: t.address, beneficiary: account, releaseTime, goal: goal ?? 0n };
      const init = initcode(ethers, kind, params);
      const salt = ethers.hexlify(ethers.randomBytes(32));
      const predicted = ethers.getCreate2Address(DEPLOYER, salt, ethers.keccak256(init));
      if ((await main.getCode(predicted)).length > 2) refuse('Address collision. Try again.');
      const data = salt + init.slice(2);
      onStep && onStep('create');
      await sendTx(signer, account, { to: DEPLOYER, data }, [DEPLOYER], {
        action: 'create', to: DEPLOYER, toLabel: 'Arbitrum standard contract deployer',
        text: 'Create your ' + (kind === 'goal' ? 'goal' : 'fixed-date') + ' lock. No coins move in this step.',
        failNote: 'No coins were moved.',
      });
      onStep && onStep('verify');
      const L = await retry(() => verifyLock(ethers, cfg, predicted, { beneficiary: account }));
      if (L.kind !== kind || lc(L.token) !== lc(t.address) || L.releaseTime !== releaseTime || (kind === 'goal' && L.goal !== goal))
        refuse('The new lock does not match what you asked for. No coins were moved.');
      return L;
    }

    async function deposit({ lock, amount, onStep }) {
      amount = BigInt(amount); if (amount <= 0n) refuse('Enter an amount.');
      const { account, signer } = await walletChecks();
      onStep && onStep('verify');
      const L = await verifyLock(ethers, cfg, lock, { beneficiary: account });
      if ((await now()) >= L.releaseTime) refuse('This lock\'s date has passed, so it no longer holds money back. Start a new lock instead. Nothing was sent.');
      const tok = cfg.tokens[L.sym];
      const erc = new ethers.Contract(tok.address, ERC20_ABI, main);
      const bal = await erc.balanceOf(account);
      if (amount > bal) refuse('That is more ' + L.sym + ' than your wallet has.');
      const before = await erc.balanceOf(L.addr);
      const data = SEL_TRANSFER + ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [L.addr, amount]).slice(2);
      onStep && onStep('send');
      await sendTx(signer, account, { to: tok.address, data }, [tok.address], {
        action: 'deposit', to: tok.address, toLabel: L.sym + ' token contract', recipient: L.addr,
        text: 'Send ' + ethers.formatUnits(amount, tok.decimals) + ' ' + L.sym + ' into your lock ' + L.addr + '.',
        failNote: 'Your coins are still in your wallet.',
      });
      const after = await retry(async () => { const a = await erc.balanceOf(L.addr); if (a < before + amount) throw new Error('not yet'); return a; });
      return { ...L, balance: after };
    }

    async function release({ lock, onStep }) {
      const { account, signer } = await walletChecks();
      onStep && onStep('verify');
      const L = await verifyLock(ethers, cfg, lock, { beneficiary: account });
      onStep && onStep('send');
      await sendTx(signer, account, { to: L.addr, data: SEL_RELEASE }, [L.addr], {
        action: 'release', to: L.addr, toLabel: 'your lock',
        text: 'Release everything in lock ' + L.addr + ' to your wallet ' + account + '.',
        failNote: 'The coins are still in the lock.',
      });
      return L;
    }

    // Servers can lag a few seconds behind a brand-new transaction, so post-transaction checks retry for ~20s.
    async function retry(fn, tries = 12) {
      for (let i = 0; ; i++) { try { return await fn(); } catch (e) { if (i >= tries) throw e; await new Promise((r) => setTimeout(r, 1700)); } }
    }

    return Object.freeze({ create, deposit, release });
  }

  return Object.freeze({
    DEPLOYER, DEPLOYER_CODEHASH, DEPLOYER_RUNTIME, CONTRACTS, LOCK_ABI, ERC20_ABI,
    selfCheck, expectedRuntime, initcode, verifyLock, makeGuard, Refused,
  });
})();
