// TimeVault test suite. Runs entirely on a private simulated blockchain (Ganache) inside the page.
// Uses the exact same TV core (contract bytes, verification, guard) as the app.
async function runTimeVaultTests(ethers, Ganache, MOCK_BYTECODE, FAKE_BYTECODE, out, opts = {}) {
  const t0 = Date.now();
  const gp = Ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4 }, chain: { vmErrorsOnRPCResponse: true } });
  const send = (m, p = []) => gp.request({ method: m, params: p });
  const [me, stranger, attacker] = (await send('eth_accounts')).map((a) => ethers.getAddress(a));
  // cacheTimeout -1: never reuse a previous answer; every read is fresh (the app does the same)
  const prov = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 }); prov.pollingInterval = 100;
  const prov2 = new ethers.BrowserProvider(gp, undefined, { cacheTimeout: -1 }); prov2.pollingInterval = 100;
  const coder = ethers.AbiCoder.defaultAbiCoder();
  const LOCK = new ethers.Interface(TV.LOCK_ABI);
  const TOK = new ethers.Interface(['constructor(string n, bool usdtStyle_)', 'function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
  const FAKE = ['constructor(address t, address b, uint256 r, uint256 g, address a)'];
  const U = (n) => ethers.parseUnits(String(n), 6), DAY = 86400;
  const now = async () => parseInt((await send('eth_getBlockByNumber', ['latest', false])).timestamp, 16);
  const warp = async (s) => { await send('evm_increaseTime', [s]); await send('evm_mine'); };
  const tx = async (from, to, data, value) => {
    const p = { from, data, gas: '0x2dc6c0' }; if (to) p.to = to; if (value) p.value = ethers.toQuantity(value);
    try { const h = await send('eth_sendTransaction', [p]); const rc = await send('eth_getTransactionReceipt', [h]); return { ok: rc.status === '0x1', rc }; }
    catch (e) { return { ok: false, reason: e.message }; }
  };
  const call = async (to, fn, args = []) => LOCK.decodeFunctionResult(fn, await send('eth_call', [{ to, data: LOCK.encodeFunctionData(fn, args) }, 'latest']))[0];
  const deployRaw = async (bytecode, types, args) => { const r = await tx(me, null, bytecode + coder.encode(types, args).slice(2)); if (!r.ok) throw new Error('deploy failed: ' + r.reason); return ethers.getAddress(r.rc.contractAddress); };
  const tryDeploy = (bytecode, types, args) => tx(me, null, bytecode + coder.encode(types, args).slice(2));
  const bal = async (tok, who) => TOK.decodeFunctionResult('balanceOf', await send('eth_call', [{ to: tok, data: TOK.encodeFunctionData('balanceOf', [who]) }, 'latest']))[0];
  const give = (tok, from, to, amt) => tx(from, tok, TOK.encodeFunctionData('transfer', [to, amt]));
  const release = (from, lock) => tx(from, lock, LOCK.encodeFunctionData('release'));
  const must = (c, m) => { if (!c) throw new Error(m); };
  const mustFail = (r, msg) => { must(!r.ok, 'expected failure but it succeeded'); if (msg) must((r.reason || '').includes(msg), 'wrong reason: ' + r.reason); };
  const eq = (a, b, m) => must(BigInt(a) === BigInt(b), m + ': got ' + a + ', want ' + b);
  let pass = 0, total = 0;
  const test = async (group, name, fn) => {
    if (opts.only && !opts.only.includes(group)) return;
    total++;
    try { await fn(); pass++; out(true, group + ' · ' + name); } catch (e) { out(false, group + ' · ' + name + ' — ' + (e.message || e)); }
  };

  // ---- setup: coins, the standard deployer
  const usdc = await deployRaw(MOCK_BYTECODE, ['string', 'bool'], ['USDC', false]);
  const usdt = await deployRaw(MOCK_BYTECODE, ['string', 'bool'], ['USDT', true]);
  const junk = await deployRaw(MOCK_BYTECODE, ['string', 'bool'], ['JUNK', false]);
  for (const t of [usdc, usdt, junk]) for (const who of [me, stranger, attacker]) await tx(me, t, TOK.encodeFunctionData('mint', [who, U(1_000_000)]));
  await send('evm_setAccountCode', [TV.DEPLOYER, TV.DEPLOYER_RUNTIME]); await send('evm_mine');
  const TT =TV.CONTRACTS.date.creation, GT = TV.CONTRACTS.goal.creation;
  const newDate = (tok, secs, ben = me) => now().then((n) => deployRaw(TT, TV.CONTRACTS.date.ctor, [tok, ben, n + secs]));
  const newGoal = (tok, goal, secs, ben = me) => now().then((n) => deployRaw(GT, TV.CONTRACTS.goal.ctor, [tok, ben, n + secs, goal]));
  const DLOCK = 'current time is before release time', GLOCK = 'goal not reached and before release time';

  // ================================================================ 1. self check
  await test('Self check', 'embedded contract code matches the tested fingerprints', async () => {
    const r = TV.selfCheck(ethers); must(r.ok, r.items.filter((i) => !i.ok).map((i) => i.label).join(', '));
  });
  await test('Self check', 'deployed locks have exactly the code the app expects', async () => {
    const n = await now();
    const a = await deployRaw(GT, TV.CONTRACTS.goal.ctor, [usdc, me, n + DAY, U(5)]);
    must((await send('eth_getCode', [a, 'latest'])).toLowerCase() === TV.expectedRuntime(ethers, 'goal', { token: usdc, beneficiary: me, releaseTime: n + DAY, goal: U(5) }).toLowerCase(), 'goal lock code differs');
    const b = await deployRaw(TT, TV.CONTRACTS.date.ctor, [usdt, me, n + DAY]);
    must((await send('eth_getCode', [b, 'latest'])).toLowerCase() === TV.expectedRuntime(ethers, 'date', { token: usdt, beneficiary: me, releaseTime: n + DAY }).toLowerCase(), 'date lock code differs');
  });

  // ================================================================ 2. fixed-date lock (OpenZeppelin TokenTimelock)
  let L;
  await test('Fixed date', 'create a 30-day lock and deposit 1,000', async () => {
    L = await newDate(usdc, 30 * DAY); must((await give(usdc, me, L, U(1000))).ok, 'deposit failed');
    eq(await bal(usdc, L), U(1000), 'lock balance'); must((await call(L, 'beneficiary')) === me, 'beneficiary');
  });
  await test('Fixed date', 'you cannot release early', async () => mustFail(await release(me, L), DLOCK));
  await test('Fixed date', 'a stranger cannot release early', async () => mustFail(await release(stranger, L), DLOCK));
  await test('Fixed date', 'still locked 1 minute before the date', async () => { await warp(30 * DAY - 60); mustFail(await release(me, L), DLOCK); });
  await test('Fixed date', 'after the date a stranger can press release, but the money goes only to you', async () => {
    await warp(120); const b = await bal(usdc, me), bs = await bal(usdc, stranger);
    must((await release(stranger, L)).ok, 'release failed');
    eq((await bal(usdc, me)) - b, U(1000), 'you received'); eq(await bal(usdc, stranger), bs, 'stranger received'); eq(await bal(usdc, L), 0, 'not empty');
  });
  await test('Fixed date', 'releasing an empty lock fails cleanly', async () => mustFail(await release(me, L), 'no tokens to release'));
  await test('Fixed date', 'cannot be created with a date in the past', async () => mustFail(await tryDeploy(TT, TV.CONTRACTS.date.ctor, [usdc, me, (await now()) - 1]), 'release time is before current time'));
  await test('Fixed date', 'topping up keeps the same date', async () => {
    const a = await newDate(usdc, 10 * DAY); await give(usdc, me, a, U(200)); await give(usdc, me, a, U(50));
    mustFail(await release(me, a), DLOCK); await warp(10 * DAY + 5); const b = await bal(usdc, me);
    must((await release(me, a)).ok, 'release failed'); eq((await bal(usdc, me)) - b, U(250), 'received');
  });
  await test('Fixed date', 'USDT-style coin works', async () => {
    const a = await newDate(usdt, DAY); must((await give(usdt, me, a, U(300))).ok, 'deposit');
    mustFail(await release(me, a), DLOCK); await warp(DAY + 5); const b = await bal(usdt, me);
    must((await release(me, a)).ok, 'release'); eq((await bal(usdt, me)) - b, U(300), 'received');
  });
  await test('Fixed date', '2-year lock blocked all the way, then pays only you', async () => {
    const a = await newDate(usdc, 730 * DAY); await give(usdc, me, a, U(5000));
    for (const d of [1, 99, 265, 363]) { await warp(d * DAY); mustFail(await release(stranger, a), DLOCK); }
    await warp(2 * DAY + 1); const b = await bal(usdc, me);
    must((await release(stranger, a)).ok, 'release'); eq((await bal(usdc, me)) - b, U(5000), 'received');
  });
  await test('Fixed date', 'only its 4 functions exist', async () => {
    const a = await newDate(usdc, DAY); const code = (await send('eth_getCode', [a, 'latest'])).toLowerCase();
    must([...code.matchAll(/8063([0-9a-f]{8})14/g)].map((m) => m[1]).sort().join(',') === '38af3eed,86d1a69f,b91d4001,fc0c546a', 'function list');
  });
  await test('Fixed date', 'random calls or ETH cannot move anything', async () => {
    const a = await newDate(usdc, 5 * DAY); await give(usdc, me, a, U(10));
    mustFail(await tx(stranger, a, '0xdeadbeef')); mustFail(await tx(stranger, a, '0x', 1n)); eq(await bal(usdc, a), U(10), 'balance changed');
  });

  // ================================================================ 3. goal lock
  let G;
  await test('Goal', 'create a $1,000 goal (2-year backup) and deposit $300', async () => {
    G = await newGoal(usdc, U(1000), 730 * DAY); must((await give(usdc, me, G, U(300))).ok, 'deposit'); eq(await call(G, 'goal'), U(1000), 'goal');
  });
  await test('Goal', 'below the goal you cannot withdraw', async () => mustFail(await release(me, G), GLOCK));
  await test('Goal', 'below the goal a stranger cannot withdraw', async () => mustFail(await release(stranger, G), GLOCK));
  await test('Goal', 'deposits over months, still blocked 1 cent below the goal', async () => {
    for (const amt of ['200', '250', '249.99']) { await warp(30 * DAY); must((await give(usdc, me, G, U(amt))).ok, 'deposit'); mustFail(await release(me, G), GLOCK); }
    eq(await bal(usdc, G), U('999.99'), 'balance');
  });
  await test('Goal', 'at exactly the goal it unlocks and pays only you', async () => {
    must((await give(usdc, me, G, U('0.01'))).ok, 'deposit'); const b = await bal(usdc, me), bs = await bal(usdc, stranger);
    must((await release(stranger, G)).ok, 'release'); eq((await bal(usdc, me)) - b, U(1000), 'you received'); eq(await bal(usdc, stranger), bs, 'stranger');
  });
  await test('Goal', 'releasing an empty lock fails cleanly', async () => mustFail(await release(me, G), 'no tokens to release'));
  await test('Goal', 'depositing again after release locks it again', async () => { must((await give(usdc, me, G, U(100))).ok, 'deposit'); mustFail(await release(me, G), GLOCK); });
  await test('Goal', 'going over the goal releases the full amount', async () => {
    const a = await newGoal(usdc, U(500), 365 * DAY); await give(usdc, me, a, U(750)); const b = await bal(usdc, me);
    must((await release(me, a)).ok, 'release'); eq((await bal(usdc, me)) - b, U(750), 'received');
  });
  await test('Goal', 'backup date: never reached $10,000, blocked the day before, open after', async () => {
    const a = await newGoal(usdc, U(10000), 365 * DAY); await give(usdc, me, a, U(3000));
    await warp(364 * DAY); mustFail(await release(stranger, a), GLOCK); await warp(DAY + 5); const b = await bal(usdc, me);
    must((await release(stranger, a)).ok, 'release'); eq((await bal(usdc, me)) - b, U(3000), 'received');
  });
  await test('Goal', 'USDT-style coin works', async () => {
    const a = await newGoal(usdt, U(200), 365 * DAY); await give(usdt, me, a, U(150)); mustFail(await release(me, a), GLOCK);
    await give(usdt, me, a, U(50)); const b = await bal(usdt, me); must((await release(me, a)).ok, 'release'); eq((await bal(usdt, me)) - b, U(200), 'received');
  });
  await test('Goal', 'coins someone else sends in can only help you', async () => {
    const a = await newGoal(usdc, U(100), 365 * DAY); await give(usdc, me, a, U(60)); await give(usdc, stranger, a, U(40));
    const b = await bal(usdc, me); must((await release(stranger, a)).ok, 'release'); eq((await bal(usdc, me)) - b, U(100), 'received');
  });
  await test('Goal', 'cannot be created with a zero goal or a past date', async () => {
    mustFail(await tryDeploy(GT, TV.CONTRACTS.goal.ctor, [usdc, me, (await now()) + DAY, 0]), 'goal is zero');
    mustFail(await tryDeploy(GT, TV.CONTRACTS.goal.ctor, [usdc, me, (await now()) - 1, U(10)]), 'release time is before current time');
  });
  await test('Goal', 'only its 5 functions exist', async () => {
    const a = await newGoal(usdc, U(1), DAY); const code = (await send('eth_getCode', [a, 'latest'])).toLowerCase();
    const want = ['token()', 'beneficiary()', 'releaseTime()', 'goal()', 'release()'].map((x) => ethers.id(x).slice(2, 10)).sort().join(',');
    must([...code.matchAll(/8063([0-9a-f]{8})14/g)].map((m) => m[1]).sort().join(',') === want, 'function list');
  });
  await test('Goal', 'random calls or ETH cannot move anything', async () => {
    const a = await newGoal(usdc, U(1000), DAY); await give(usdc, me, a, U(10));
    mustFail(await tx(stranger, a, '0xdeadbeef')); mustFail(await tx(stranger, a, '0x', 1n)); eq(await bal(usdc, a), U(10), 'balance changed');
  });

  // ================================================================ 4. stress test: random sequences vs. a model
  await test('Stress', (opts.rounds || 40) + ' random locks × 14 random actions each, money only ever goes where the rules say', async () => {
    let seed = opts.seed || ((Date.now() % 1e9) | 0); const seed0 = seed;
    const rnd = () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const holders = [me, stranger, attacker];
    let ops = 0;
    for (let r = 0; r < (opts.rounds || 40); r++) {
      const kind = rnd() < 0.6 ? 'goal' : 'date', tok = pick([usdc, usdt]);
      const goal = U(1 + Math.floor(rnd() * 500));
      const start = await now(); const T = start + (1 + Math.floor(rnd() * 120)) * DAY + DAY / 2;
      const lock = kind === 'goal' ? await deployRaw(GT, TV.CONTRACTS.goal.ctor, [tok, me, T, goal]) : await deployRaw(TT, TV.CONTRACTS.date.ctor, [tok, me, T]);
      let model = 0n;
      const total0 = (await Promise.all(holders.map((h) => bal(tok, h)))).reduce((a, b) => a + b, 0n);
      for (let k = 0; k < 14; k++) {
        const op = pick(['deposit', 'deposit', 'warp', 'release', 'release']); ops++;
        if (op === 'deposit') {
          const from = pick([me, me, stranger, attacker]), amt = U(1 + Math.floor(rnd() * 300));
          must((await give(tok, from, lock, amt)).ok, 'deposit failed'); model += amt;
        } else if (op === 'warp') {
          await warp(Math.floor(rnd() * 40) * DAY);
        } else {
          const caller = pick(holders); const t = (await now()) + 1;
          const expectOk = model > 0n && (t >= T || (kind === 'goal' && model >= goal));
          const before = await Promise.all(holders.map((h) => bal(tok, h)));
          const r2 = await release(caller, lock);
          must(r2.ok === expectOk, `round ${r} op ${k}: release by ${caller === me ? 'owner' : 'other'} ${r2.ok ? 'succeeded' : 'failed'} but rules say it should ${expectOk ? 'succeed' : 'fail'} (seed ${seed0})`);
          const after = await Promise.all(holders.map((h) => bal(tok, h)));
          if (r2.ok) { eq(after[0] - before[0], model, 'owner must receive everything'); eq(after[1], before[1], 'stranger got money'); eq(after[2], before[2], 'attacker got money'); model = 0n; }
          else for (let i = 0; i < 3; i++) eq(after[i], before[i], 'balances changed on a failed release');
        }
        eq(await bal(tok, lock), model, 'lock balance differs from model (seed ' + seed0 + ')');
        const tot = (await Promise.all(holders.map((h) => bal(tok, h)))).reduce((a, b) => a + b, 0n) + model;
        eq(tot, total0, 'coins appeared or vanished');
      }
    }
    out(true, 'Stress · ran ' + ops + ' random actions (seed ' + seed0 + ')', true);
  });

  // ================================================================ 5. the guard (the app's only way to send)
  let sends = 0; const asked = [];
  const signer = await prov.getSigner(me);
  const origSend = signer.sendTransaction.bind(signer);
  signer.sendTransaction = (t) => { sends++; return origSend(t); };
  const tokens = { USDC: { address: usdc, decimals: 6 }, USDT: { address: usdt, decimals: 6 } };
  const baseCfg = { providers: [prov, prov2], need: 2, tokens, chainId: Number((await prov.getNetwork()).chainId), getSigner: async () => signer, getAccount: () => me, onAsk: async (s) => { asked.push(s); return true; } };
  const guard = TV.makeGuard(ethers, baseCfg);
  const noSend = async (fn, msg) => {
    const s0 = sends;
    try { await fn(); } catch (e) { must(e.refused, 'failed but not refused by the guard: ' + e.message); if (msg) must(e.message.includes(msg), 'wrong refusal: ' + e.message); must(sends === s0, 'the wallet was asked to sign'); return; }
    throw new Error('the guard allowed it');
  };
  let GL;
  await test('Guard', 'only three actions exist: create, deposit, release', async () => must(Object.keys(guard).sort().join() === 'create,deposit,release', Object.keys(guard).join()));
  await test('Guard', 'create a goal lock: lands at the predicted address, pays you, exact tested code', async () => {
    const n = await now();
    GL = await guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 400 * DAY, goal: U(100) });
    must(GL.beneficiary === me && GL.kind === 'goal' && GL.goal === U(100), 'bad lock');
    must(asked.at(-1).to === TV.DEPLOYER, 'wallet was asked to send somewhere other than the deployer');
  });
  await test('Guard', 'deposit 60 into your lock', async () => { await guard.deposit({ lock: GL.addr, amount: U(60) }); eq(await bal(usdc, GL.addr), U(60), 'lock balance'); must(asked.at(-1).recipient === GL.addr, 'recipient'); });
  await test('Guard', 'release below the goal is stopped before your wallet is even asked', async () => noSend(() => guard.release({ lock: GL.addr }), 'Dry run failed'));
  await test('Guard', 'reach the goal and release: everything comes back to you', async () => {
    await guard.deposit({ lock: GL.addr, amount: U(40) }); const b = await bal(usdc, me);
    await guard.release({ lock: GL.addr }); eq((await bal(usdc, me)) - b, U(100), 'received'); eq(await bal(usdc, GL.addr), 0, 'not empty');
  });
  await test('Guard', 'create a fixed-date USDT lock', async () => { const n = await now(); const D = await guard.create({ kind: 'date', sym: 'USDT', releaseTime: n + 30 * DAY }); must(D.kind === 'date' && D.sym === 'USDT', 'bad lock'); });
  await test('Guard', 'REFUSES a fake look-alike lock that claims to pay you but pays an attacker', async () => {
    const n = await now(); const fake = await deployRaw(FAKE_BYTECODE, ['address', 'address', 'uint256', 'uint256', 'address'], [usdc, me, n + 30 * DAY, U(1000), attacker]);
    must((await call(fake, 'beneficiary')) === me, 'fake should claim to pay me');
    await noSend(() => guard.deposit({ lock: fake, amount: U(5) }), 'not a TimeVault lock');
  });
  await test('Guard', 'REFUSES a genuine lock that pays someone else', async () => {
    const other = await newGoal(usdc, U(100), 30 * DAY, attacker); await noSend(() => guard.deposit({ lock: other, amount: U(5) }), 'pays a different wallet');
  });
  await test('Guard', 'REFUSES sending to a normal wallet address', async () => noSend(() => guard.deposit({ lock: attacker, amount: U(5) }), 'not a TimeVault lock'));
  await test('Guard', 'REFUSES a lock holding an unsupported coin', async () => { const j = await newGoal(junk, U(100), 30 * DAY); await noSend(() => guard.deposit({ lock: j, amount: U(5) }), 'does not support'); });
  await test('Guard', 'REFUSES depositing into a lock whose date has passed', async () => {
    const n = await now(); const E = await guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 2 * 3600, goal: U(10) });
    await warp(3 * 3600); await noSend(() => guard.deposit({ lock: E.addr, amount: U(5) }), 'date has passed');
  });
  await test('Guard', 'REFUSES depositing more than your wallet has', async () => {
    const n = await now(); const M = await guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 30 * DAY, goal: U(10) });
    const mine = await bal(usdc, me);
    await noSend(() => guard.deposit({ lock: M.addr, amount: mine + 1n }), 'more USDC than your wallet has');
  });
  await test('Guard', 'REFUSES releasing a lock that is not yours', async () => { const o = await newDate(usdc, DAY, attacker); await noSend(() => guard.release({ lock: o }), 'pays a different wallet'); });
  await test('Guard', 'REFUSES bad settings before asking the wallet (zero goal, past date, 11 years)', async () => {
    const n = await now();
    await noSend(() => guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 30 * DAY, goal: 0n }), 'more than zero');
    await noSend(() => guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n - 10, goal: U(5) }), 'at least an hour');
    await noSend(() => guard.create({ kind: 'date', sym: 'USDC', releaseTime: n + 11 * 365 * DAY }), 'at most 10 years');
    await noSend(() => guard.create({ kind: 'goal', sym: 'JUNK', releaseTime: n + 30 * DAY, goal: U(5) }), 'Unsupported coin');
  });
  await test('Guard', 'REFUSES when one server lies about a lock\'s code', async () => {
    const liar = { getCode: async (a) => (await prov.getCode(a)).slice(0, -2) + 'ff', call: (t) => prov.call(t), getBlock: (b) => prov.getBlock(b), provider: prov };
    const n = await now(); const ok = await guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 30 * DAY, goal: U(10) });
    const g2 = TV.makeGuard(ethers, { ...baseCfg, providers: [prov, liar] });
    await noSend(() => g2.deposit({ lock: ok.addr, amount: U(1) }), 'disagree');
  });
  await test('Guard', 'REFUSES when servers cannot be reached', async () => {
    const dead = { getCode: async () => { throw new Error('offline'); }, call: async () => { throw new Error('offline'); }, getBlock: (b) => prov.getBlock(b), provider: prov };
    const g3 = TV.makeGuard(ethers, { ...baseCfg, providers: [prov, dead] });
    await noSend(() => g3.deposit({ lock: GL.addr, amount: U(1) }), 'Could not reach enough');
  });
  await test('Guard', 'REFUSES if the deployer contract has been tampered with', async () => {
    const setDeployer = async (code) => {
      await send('evm_setAccountCode', [TV.DEPLOYER, code]); await send('evm_mine');
      must((await send('eth_getCode', [TV.DEPLOYER, 'latest'])).toLowerCase() === code.toLowerCase(), 'could not set deployer code');
    };
    await setDeployer(TV.DEPLOYER_RUNTIME.slice(0, -2) + '00');
    const n = await now();
    try { await noSend(() => guard.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 30 * DAY, goal: U(5) }), 'standard deployer on this network looks wrong'); }
    finally { await setDeployer(TV.DEPLOYER_RUNTIME); }
  });
  await test('Guard', 'REFUSES when the wallet is on the wrong network', async () => {
    const g4 = TV.makeGuard(ethers, { ...baseCfg, chainId: 42161 + 999 });
    await noSend(() => g4.deposit({ lock: GL.addr, amount: U(1) }), 'not on Arbitrum');
  });
  await test('Guard', 'REFUSES when the connected account changed', async () => {
    const g5 = TV.makeGuard(ethers, { ...baseCfg, getAccount: () => stranger });
    await noSend(() => g5.deposit({ lock: GL.addr, amount: U(1) }), 'account changed');
  });
  await test('Guard', 'nothing is sent if you press Cancel on the confirm screen', async () => {
    const g6 = TV.makeGuard(ethers, { ...baseCfg, onAsk: async () => false });
    const n = await now(); await noSend(() => g6.create({ kind: 'goal', sym: 'USDC', releaseTime: n + 30 * DAY, goal: U(5) }), 'Cancelled');
  });

  return { pass, total, seconds: Math.round((Date.now() - t0) / 1000) };
}
