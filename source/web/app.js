// TimeVault app. All transactions go through TV.makeGuard (core.js). This file only builds the screens.
(() => {
  'use strict';
  const CHAIN_ID = 42161;
  const RPCS = ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org', 'https://arbitrum.meowrpc.com'];
  // Coin addresses: Circle's native USDC and Tether's USDT on Arbitrum One.
  const TOKENS = { USDC: { address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', decimals: 6 }, USDT: { address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', decimals: 6 } };
  const SYMBOL = Object.fromEntries(Object.entries(TOKENS).map(([k, v]) => [v.address.toLowerCase(), k]));
  const ERC20 = ['function balanceOf(address) view returns (uint256)'];
  const DAY = 86400;
  // Built-in WalletConnect Project ID (a public identifier, not a secret). Set at build time from walletconnect_project_id.txt.
  const BUILT_IN_WC_ID = '__WC_PROJECT_ID__'.startsWith('__') ? '' : '__WC_PROJECT_ID__';
  const TESTS_URL = 'https://relive202.github.io/timevault/tests.html';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (a ? a.slice(0, 8) + '…' + a.slice(-7) : ''); // long enough that look-alike scam addresses don't match
  const fmt = (x) => Number(ethers.formatUnits(x, 6));
  const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, d = 2) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const dateStr = (s) => new Date(Number(s) * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const untilStr = (ts) => { const d = (Number(ts) - Date.now() / 1000) / 86400; if (d <= 0) return 'now'; if (d < 1) return 'today'; if (d < 61) return Math.ceil(d) + (Math.ceil(d) === 1 ? ' day' : ' days'); if (d < 730) return Math.round(d / 30.44) + ' months'; return (Math.round(d / 36.5) / 10) + ' years'; };
  const dayStr = (d) => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const store = {
    get(k, d = '') { try { const v = localStorage.getItem('tv3.' + k); return v === null ? d : v; } catch { return d; } },
    set(k, v) { try { v === '' || v == null ? localStorage.removeItem('tv3.' + k) : localStorage.setItem('tv3.' + k, v); } catch {} },
    json(k, d) { try { return JSON.parse(this.get(k, '')) ?? d; } catch { return d; } },
    setJson(k, v) { this.set(k, JSON.stringify(v)); },
  };

  // ------------------------------------------------------------------ startup self check (blocks money actions if it fails)
  // Running inside the Android app? (Capacitor injects window.Capacitor before this script runs.)
  const NATIVE = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  const LN = NATIVE && window.Capacitor.Plugins ? window.Capacitor.Plugins.LocalNotifications : null;
  if (NATIVE) document.body.classList.add('native');

  const SELF = TV.selfCheck(ethers);
  if (!SELF.ok) document.body.classList.add('broken');

  // ------------------------------------------------------------------ read-only blockchain access: 4 independent servers
  const providers = RPCS.map((u) => {
    const req = new ethers.FetchRequest(u); req.timeout = 9000;
    return new ethers.JsonRpcProvider(req, CHAIN_ID, { staticNetwork: ethers.Network.from(CHAIN_ID), cacheTimeout: -1, batchMaxCount: 1 });
  });
  const main = providers[0];
  const verifyCfg = { providers, need: 2, tokens: TOKENS };

  // ------------------------------------------------------------------ wallet
  let wc = null, eip = null, account = '', chainId = 0;
  const viewer = () => account || store.get('watch');

  const guard = TV.makeGuard(ethers, {
    providers, need: 2, tokens: TOKENS, chainId: CHAIN_ID, maxBaseFee: ethers.parseUnits('2', 'gwei'),
    getAccount: () => account,
    getSigner: async () => { if (!eip) throw new TV.Refused('Connect your wallet first.'); return new ethers.BrowserProvider(eip).getSigner(account); },
    onAsk: confirmScreen,
  });

  function setAccount(a, c) {
    account = a ? ethers.getAddress(a) : ''; chainId = Number(c || 0);
    const p = $('netPill');
    document.querySelectorAll('[data-connect]').forEach((b) => { b.textContent = account ? 'Disconnect wallet' : 'Connect wallet'; b.className = account ? 'btn ghost small' : b.dataset.cls; });
    $('welcome').hidden = !!viewer(); $('homeMain').hidden = !viewer(); $('copyMine').hidden = !account;
    p.hidden = !account && !store.get('watch');
    if (!account) { p.textContent = store.get('watch') ? 'Viewing ' + short(store.get('watch')) : 'Not connected'; p.className = 'pill'; $('connectBtn').textContent = 'Connect wallet'; }
    else if (chainId !== CHAIN_ID) { p.textContent = 'Wrong network'; p.className = 'pill warn'; $('connectBtn').textContent = 'Disconnect'; }
    else { p.textContent = short(account); p.className = 'pill ok'; $('connectBtn').textContent = 'Disconnect'; }
    refresh();
  }
  async function ensureArbitrum() {
    if (!eip) throw new TV.Refused('Connect your wallet first.');
    await wakeConnection();
    const c = Number(await eip.request({ method: 'eth_chainId' }));
    if (c === CHAIN_ID) return;
    try { await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] }); chainId = CHAIN_ID; }
    catch { throw new TV.Refused('Switch your wallet to Arbitrum One, then try again.'); }
  }
  async function initWc(connectNow) {
    const projectId = store.get('wcid') || BUILT_IN_WC_ID;
    if (!projectId) { if (connectNow) { show('setup'); document.querySelector('details.advanced').open = true; $('wcId').focus(); toast('This copy of TimeVault needs a WalletConnect Project ID. Add one under Advanced.', 8000); } return; }
    if (!wc) {
      const { EthereumProvider } = window['@walletconnect/ethereum-provider'];
      wc = await EthereumProvider.init({
        projectId, optionalChains: [CHAIN_ID], showQrModal: false, rpcMap: { [CHAIN_ID]: RPCS[0] },
        optionalMethods: ['eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain'],
        metadata: { name: 'TimeVault', description: 'Personal savings locks', url: location.origin.startsWith('http') ? location.origin : 'https://timevault.local', icons: [] },
      });
      wc.on('display_uri', (uri) => {
        $('qrBox').hidden = false; $('uriText').textContent = uri; $('copyUri').dataset.uri = uri;
        const touch = window.matchMedia && matchMedia('(pointer: coarse)').matches;
        $('openWallet').hidden = !touch; document.querySelectorAll('#qrBox details')[1].open = !touch;
        $('openWallet').onclick = () => { location.href = uri; };
        try { const q = qrcode(0, 'M'); q.addData(uri); q.make(); $('qr').innerHTML = q.createImgTag(5, 8); } catch { $('qr').textContent = 'Use Copy link instead.'; }
      });
      wc.on('accountsChanged', (a) => setAccount(a[0], wc.chainId));
      wc.on('chainChanged', (c) => setAccount(account, c));
      wc.on('disconnect', () => { eip = null; setAccount(''); });
    }
    if (wc.session && wc.accounts?.length) { eip = wc; setAccount(wc.accounts[0], wc.chainId); return; }
    if (connectNow) {
      try { await wc.connect(); eip = wc; $('qrBox').hidden = true; setAccount(wc.accounts[0], wc.chainId); toast('Wallet connected.'); show('home'); }
      catch (e) { $('qrBox').hidden = true; toast(nice(e)); }
    }
  }
  async function connectClick() {
    if (account) { try { if (eip === wc) await wc.disconnect(); } catch {} eip = null; setAccount(''); toast('Wallet disconnected.'); return; }
    try { await initWc(true); } catch (e) { toast('Could not start the wallet connection: ' + nice(e)); }
  }
  $('connectBtn').addEventListener('click', connectClick);
  document.querySelectorAll('[data-connect]').forEach((b) => { b.dataset.cls = b.className; b.addEventListener('click', connectClick); });
  $('wcSave').addEventListener('click', () => { store.set('wcid', $('wcId').value.trim()); wc = null; toast($('wcId').value.trim() ? 'Saved. Now tap Connect wallet.' : 'Cleared. Using the built-in one.'); });
  $('copyUri').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('copyUri').dataset.uri); toast('Copied. Now open your wallet app, find WalletConnect or the scan button, and paste.', 8000); } catch { toast('Select the link text and copy it.'); } });
  $('copyMine').addEventListener('click', async () => { try { await navigator.clipboard.writeText(account); toast('Copied ' + short(account) + '. Paste it as the withdrawal address and pick Arbitrum One.', 8000); } catch { toast(account, 10000); } });
  $('cancelWc').addEventListener('click', () => { $('qrBox').hidden = true; toast('Connection cancelled.'); });
  $('watchSave').addEventListener('click', () => {
    const v = $('watchAddr').value.trim();
    if (v && !ethers.isAddress(v)) return toast('That is not a valid wallet address. It should start with 0x.');
    store.set('watch', v ? ethers.getAddress(v) : ''); setAccount(account, chainId);
  });

  function nice(e) {
    const m = String(e?.shortMessage || e?.reason || e?.message || e);
    if (e?.refused) return m;
    if (e?.code === 'ACTION_REJECTED' || /reject|denied|cancel/i.test(m)) return 'Cancelled in your wallet. Nothing was sent.';
    if (/insufficient funds/i.test(m)) return 'Not enough ETH on Arbitrum for the network fee.';
    return m.slice(0, 220);
  }

  // ------------------------------------------------------------------ confirm screen (shown BEFORE the wallet is asked)
  function confirmScreen(s) {
    return new Promise((resolve) => {
      const lines = {
        create: ['Create your lock', 'Your wallet will ask you to approve a contract interaction with:', s.to, 'This sets up your empty lock using Arbitrum\'s standard contract creator. No money moves yet. The network fee is a few cents of ETH.'],
        deposit: ['Add money to your lock', 'Your wallet will show a transfer to your lock:', s.recipient, s.text],
        release: ['Withdraw to your wallet', 'Your wallet will ask you to approve a contract interaction with your lock:', s.to, s.text],
      }[s.action];
      $('cfTitle').textContent = lines[0]; $('cfLead').textContent = lines[1];
      $('cfAddr').textContent = lines[2]; $('cfText').textContent = lines[3];
      $('confirm').hidden = false; $('cfGo').focus();
      const done = (v) => { $('confirm').hidden = true; $('cfGo').onclick = $('cfNo').onclick = null; if (v) { waiting(true); if (isTouch()) setTimeout(openWalletApp, 700); } resolve(v); };
      $('cfGo').onclick = () => done(true); $('cfNo').onclick = () => done(false);
    });
  }
  // ---- waiting for the wallet: bring it to the front, offer a way out if the request never shows up
  let waitT = null, stopWait = null;
  const isTouch = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
  function waiting(on) {
    $('waitBar').hidden = !on; clearTimeout(waitT); $('wbStop').hidden = true;
    $('wbSub').textContent = 'Your wallet app should open with the request. It can take a few seconds to show up.';
    if (on) waitT = setTimeout(() => {
      $('wbStop').hidden = false;
      $('wbSub').textContent = 'Not showing up? Tap Open wallet and keep it open on its main screen for a few seconds. Still nothing? Tap Stop waiting and try again.';
    }, 25000);
  }
  function openWalletApp() {
    const md = wc && wc.session && wc.session.peer && wc.session.peer.metadata;
    const link = md && md.redirect && (md.redirect.native || md.redirect.universal);
    if (link) { try { location.href = link; } catch {} } else toast('Open your wallet app to see the request.');
  }
  async function wakeConnection() { // phones put the WalletConnect link to sleep in the background
    try { const r = wc && wc.signer && wc.signer.client && wc.signer.client.core && wc.signer.client.core.relayer; if (r && r.connected === false && typeof r.restartTransport === 'function') await r.restartTransport(); } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wakeConnection(); });
  $('wbOpen').addEventListener('click', openWalletApp);
  $('wbStop').addEventListener('click', () => { if (stopWait) stopWait(); });

  // ------------------------------------------------------------------ locks: list, verification, balances
  const listKey = (w) => 'locks.' + w.toLowerCase();
  const getList = (w) => store.json(listKey(w), []);
  const hiddenKey = (w) => 'hidden.' + w.toLowerCase();
  const isHidden = (w, a) => store.json(hiddenKey(w), []).includes(a.toLowerCase());
  // finished = empty AND (its date has passed OR money went in before, i.e. it was withdrawn)
  const isFinished = (l) => l.balance === 0n && (Date.now() / 1000 >= l.releaseTime || !!(history && history.some((h) => h.to === l.addr)));
  const addLock = (w, entry) => { const l = getList(w).filter((x) => x.addr.toLowerCase() !== entry.addr.toLowerCase()); l.push(entry); store.setJson(listKey(w), l); };
  const verified = new Map();   // addr -> verified lock info (this session)
  const rejected = new Map();   // addr -> reason

  // Lock code and settings can never change after creation, so a lock verified once stays verified.
  // This cache only speeds up the screens: every deposit or withdrawal is verified again from scratch by the guard.
  const big = (v) => (v === undefined || v === null ? v : String(v));
  const unbig = (v) => (v === undefined || v === null ? v : BigInt(v));
  const serL = (L) => ({ ...L, goal: big(L.goal), balance: big(L.balance) });
  const deL = (o) => ({ ...o, goal: unbig(o.goal), balance: unbig(o.balance) });
  async function verifyCached(addr, who) {
    if (verified.has(addr)) return verified.get(addr);
    const saved = store.json('v.' + addr.toLowerCase(), null);
    if (saved && saved.addr === addr && saved.beneficiary === ethers.getAddress(who)) { const L = deL(saved); verified.set(addr, L); return L; }
    const L = await TV.verifyLock(ethers, verifyCfg, addr, { beneficiary: who });
    verified.set(addr, L); rejected.delete(addr); store.setJson('v.' + addr.toLowerCase(), serL(L)); return L;
  }

  let LOCKS = []; let WALLET = {}; let lastSig = '';
  let refreshSeq = 0, shownFor = '', loadedOnce = false;
  const cacheKey = (w) => 'cache.' + w.toLowerCase();
  function setUpdating(on) { $('upd').hidden = !on; }
  async function refresh() {
    const who = viewer();
    renderSelf();
    if (!who) { LOCKS = []; WALLET = {}; shownFor = ''; render(); return; }
    const seq = ++refreshSeq;
    if (shownFor !== who) { // first look at this wallet: show the last known numbers right away
      shownFor = who; loadedOnce = false;
      const c = store.json(cacheKey(who), null);
      if (c) { WALLET = Object.fromEntries(Object.entries(c.w || {}).map(([k, v]) => [k, BigInt(v)])); LOCKS = (c.l || []).map(deL); }
      else { WALLET = {}; LOCKS = []; }
      render(); loadHistory(true);
    }
    setUpdating(true);
    const walletP = Promise.all([main.getBalance(who), ...Object.values(TOKENS).map((t) => new ethers.Contract(t.address, ERC20, main).balanceOf(who))])
      .then(([eth, ...bals]) => ({ ETH: eth, ...Object.fromEntries(Object.keys(TOKENS).map((k, i) => [k, bals[i]])) })).catch(() => null);
    const list = getList(who).filter((e) => !isHidden(who, e.addr));
    const out = [];
    const locksP = Promise.all(list.map(async (e) => {
      try {
        const L = await verifyCached(ethers.getAddress(e.addr), who);
        const balance = await new ethers.Contract(L.token, ERC20, main).balanceOf(L.addr);
        out.push({ ...L, balance, created: e.created || 0, block: e.block || 0, name: e.name || '' });
        if (!loadedOnce && seq === refreshSeq) { // first look: show each lock as soon as it is checked
          const have = new Set(out.map((x) => x.addr)); LOCKS = [...out, ...LOCKS.filter((x) => !have.has(x.addr))].sort((x, y) => (x.kind === y.kind ? x.releaseTime - y.releaseTime : x.kind === 'goal' ? -1 : 1)); render();
        }
      } catch (err) { if (err.refused) rejected.set(e.addr, err.message); else { const old = LOCKS.find((x) => x.addr.toLowerCase() === e.addr.toLowerCase()); if (old) out.push(old); } }
    }));
    const [w] = await Promise.all([walletP, locksP]);
    if (seq !== refreshSeq || viewer() !== who) return; // a newer refresh is running
    if (w) WALLET = w;
    LOCKS = out.sort((a, b) => (a.kind === b.kind ? a.releaseTime - b.releaseTime : a.kind === 'goal' ? -1 : 1));
    loadedOnce = true;
    store.setJson(cacheKey(who), { w: Object.fromEntries(Object.entries(WALLET).map(([k, v]) => [k, String(v)])), l: LOCKS.map(serL), t: Date.now() });
    setUpdating(false);
    const sig = LOCKS.map((l) => l.addr + l.balance + l.name).sort().join() + '|' + Object.values(WALLET).join();
    if (sig !== lastSig) { lastSig = sig; render(); planChanged(); } else renderToday();
    loadHistory();
  }

  // ------------------------------------------------------------------ screens
  const TABS = ['home', 'new', 'coach', 'setup', 'safety'];
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  function show(t) {
    TABS.forEach((x) => { $('tab-' + x).hidden = x !== t; });
    document.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === t)));
    store.set('tab', t); window.scrollTo(0, 0);
  }
  let toastT;
  function toast(m, ms = 5000) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms); }

  function render() {
    const now = Date.now() / 1000;
    const total = LOCKS.reduce((s, l) => s + fmt(l.balance), 0);
    countTo($('totalLocked'), total);
    $('homeMain').classList.toggle('loading', !loadedOnce && !LOCKS.length);
    const active = LOCKS.filter((l) => !isFinished(l));
    $('lockCount').textContent = String(active.length);
    const goal = LOCKS.find((l) => l.kind === 'goal' && now < l.releaseTime && l.balance < l.goal);
    const gp = goal ? Math.min(100, Math.floor(100 * fmt(goal.balance) / fmt(goal.goal))) : (LOCKS.some((l) => l.kind === 'goal' && l.balance >= l.goal && l.balance > 0n) ? 100 : 0);
    $('nextMilestone').textContent = goal ? (goal.name || money(fmt(goal.goal))) : '—';
    $('dialPct').textContent = gp + '%';
    $('dialCap').textContent = goal ? 'of ' + money(fmt(goal.goal)).replace('.00', '') : (gp === 100 ? 'goal reached' : 'no goal yet');
    $('dialFill').style.strokeDashoffset = String(251.33 * (1 - gp / 100));
    $('walletTotal').textContent = WALLET.USDC !== undefined ? money(fmt(WALLET.USDC) + fmt(WALLET.USDT)) : '—';
    $('walletLine').textContent = WALLET.USDC !== undefined
      ? num(fmt(WALLET.USDC)) + ' USDC · ' + num(fmt(WALLET.USDT)) + ' USDT · ' + Number(ethers.formatEther(WALLET.ETH)).toFixed(5) + ' ETH for fees'
      : (viewer() ? 'Loading balances…' : '');
    $('gasHint').hidden = !(WALLET.ETH !== undefined && WALLET.ETH < ethers.parseEther('0.0002'));
    for (const o of $('lkToken').options) o.textContent = o.value + (WALLET[o.value] !== undefined ? ' (you have ' + num(fmt(WALLET[o.value])) + ')' : '');
    renderLocks(); renderToday(); renderCoach(); updateSummary(); checkMilestones();
    const tgt = $('cTarget'); const cur = store.get('plan.target');
    tgt.innerHTML = '<option value="">Choose one of your goals</option>' + LOCKS.filter((l) => l.kind === 'goal').map((l) => '<option value="' + l.addr + '"' + (l.addr === cur ? ' selected' : '') + '>' + esc((l.name ? l.name + ' · ' : '') + num(fmt(l.goal)) + ' ' + l.sym + ' goal · ' + short(l.addr)) + '</option>').join('');
  }

  // ------------------------------------------------------------------ milestone celebrations (25 / 50 / 75 / 100 % of a goal)
  const MILESTONES = [25, 50, 75, 100];
  function checkMilestones() {
    if (!account || !$('cheer').hidden) return;
    for (const l of LOCKS) {
      if (l.kind !== 'goal' || l.beneficiary !== account || l.balance === 0n) continue;
      const pct = Number(l.balance * 100n / l.goal);
      const hit = MILESTONES.filter((m) => pct >= m).pop() || 0;
      const key = 'ms.' + l.addr.toLowerCase(); const seen = store.get(key);
      if (seen === '') { store.set(key, String(hit)); continue; } // first time we see this lock: no party for old progress
      if (hit > Number(seen)) {
        store.set(key, String(hit));
        const name = l.name || 'your ' + num(fmt(l.goal)) + ' ' + l.sym + ' goal';
        $('cheerPct').textContent = hit + '%';
        $('cheerTitle').textContent = hit === 100 ? 'Goal reached!' : hit === 75 ? 'Almost there!' : hit === 50 ? 'Halfway there!' : 'Great start!';
        $('cheerText').textContent = hit === 100
          ? 'You saved ' + num(fmt(l.balance)) + ' ' + l.sym + ' for ' + name + '. You can withdraw it whenever you like, or keep going and set a bigger goal.'
          : 'You have saved ' + num(fmt(l.balance)) + ' of ' + num(fmt(l.goal)) + ' ' + l.sym + ' for ' + name + '. ' + num(Math.max(0, fmt(l.goal) - fmt(l.balance))) + ' to go.';
        $('cheerOk').textContent = hit === 100 ? 'Nice!' : 'Keep going';
        $('cheer').hidden = false;
        return;
      }
    }
  }
  $('cheerOk').addEventListener('click', () => { $('cheer').hidden = true; checkMilestones(); });

  let countFrom = null, countRaf = 0;
  function countTo(el, v) { // the total glides to its new value instead of jumping
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (countFrom === null || reduce || countFrom === v) { countFrom = v; el.textContent = money(v); return; }
    const a = countFrom, t0 = performance.now(), dur = 700; countFrom = v; cancelAnimationFrame(countRaf);
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = money(a + (v - a) * e); if (k < 1) countRaf = requestAnimationFrame(step); };
    countRaf = requestAnimationFrame(step);
  }

  function lockState(l) {
    const now = Date.now() / 1000, timeUp = now >= l.releaseTime, goalHit = l.kind === 'goal' && l.balance >= l.goal, empty = l.balance === 0n;
    const ready = !empty && (timeUp || goalHit);
    let label, cls;
    if (l.kind === 'goal') {
      if (empty && timeUp) { label = 'Finished'; cls = 'done'; }
      else if (goalHit) { label = 'Goal reached'; cls = 'open'; }
      else if (timeUp) { label = 'Backup date passed'; cls = 'open'; }
      else { label = 'Saving · ' + Math.floor(100 * fmt(l.balance) / fmt(l.goal)) + '%'; cls = 'locked'; }
    } else {
      if (empty && timeUp) { label = 'Finished'; cls = 'done'; }
      else if (timeUp) { label = 'Ready'; cls = 'open'; }
      else { const d = Math.ceil((l.releaseTime - now) / DAY); label = 'Locked · ' + d + (d === 1 ? ' day' : ' days') + ' left'; cls = 'locked'; }
    }
    return { ready, timeUp, goalHit, empty, label, cls };
  }

  function renderLocks() {
    const box = $('locks'); const who = viewer();
    if (!who) { box.innerHTML = '<div class="empty">Connect your wallet to see your savings.</div>'; return; }
    const openAddrs = new Set([...box.querySelectorAll('article[data-addr] details[open]')].map((d) => d.closest('article').dataset.addr));
    if (!loadedOnce && !LOCKS.length && getList(who).length) { box.innerHTML = '<div class="lock skel"></div><div class="lock skel"></div>'; return; }
    const rej = [...rejected.entries()];
    if (!LOCKS.length) {
      box.innerHTML = '<div class="empty"><b>No locks yet.</b><br>Tap <b>New lock</b> below to start saving.<br><span class="small">Made locks before on another phone? Tap <b>Find my locks</b>.</span></div>';
    } else box.innerHTML = '';
    const now = Date.now() / 1000;
    const finished = [];
    for (const l of LOCKS) {
      const s = lockState(l); const g = l.kind === 'goal';
      if (isFinished(l)) { finished.push(l); continue; }
      const pct = g ? Math.min(100, 100 * fmt(l.balance) / fmt(l.goal)) : Math.min(100, Math.max(0, l.created ? (now - l.created) / (l.releaseTime - l.created) * 100 : (s.timeUp ? 100 : 0)));
      const el = document.createElement('article'); el.className = 'lock'; el.dataset.addr = l.addr;
      el.innerHTML =
        '<div class="lock-top"><div><div class="label">' + (l.name ? esc(l.name) : (g ? 'Savings goal' : 'Locked until a date')) + '</div>' +
        '<div class="lock-amt">' + num(fmt(l.balance)) + (g ? '<span class="of"> / ' + num(fmt(l.goal)) + '</span>' : '') + ' ' + l.sym + '</div></div>' +
        '<span class="state ' + s.cls + '">' + s.label + '</span></div>' +
        (s.empty && s.timeUp ? '' : '<div class="bar' + (g ? ' goalbar' : '') + '" role="progressbar" aria-valuenow="' + pct.toFixed(0) + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct.toFixed(1) + '%"></i></div>') +
        '<div class="kv">' +
          (g ? '<div><span class="label">To go</span>' + (s.goalHit ? 'Done' : num(Math.max(0, fmt(l.goal) - fmt(l.balance))) + ' ' + l.sym) + '</div><div><span class="label">Backup date</span>' + dateStr(l.releaseTime) + (s.timeUp ? '' : ' <span class="muted small">(' + untilStr(l.releaseTime) + ')</span>') + '</div>'
             : '<div><span class="label">Unlocks</span>' + dateStr(l.releaseTime) + (s.timeUp ? '' : ' <span class="muted small">(' + untilStr(l.releaseTime) + ')</span>') + '</div>') +
          '<div><span class="label">Pays out to</span><span class="mono">' + short(l.beneficiary) + (account && account === l.beneficiary ? ' (you)' : '') + '</span></div>' +
          '<div><span class="label">Safety check</span><span class="ok-text">✓ Genuine lock</span></div>' +
        '</div>' +
        (g && s.timeUp && !s.empty ? '<p class="note">The backup date has passed, so this money is free. Withdraw it and start a new goal.</p>' : '') + (g && s.goalHit && !s.empty && !s.timeUp ? '<p class="note">You did it! Withdraw your savings whenever you like.</p>' : '') +
        '<details><summary>Details</summary><p class="small caution">Only ever send ' + l.sym + ' on the Arbitrum One network to this address, using Add money. Any other coin or network sent here is lost forever.</p><div class="mono small">Lock ' + l.addr + '<br>Coin ' + l.token + '<br>Pays to ' + l.beneficiary + '<br>Contract ' + (g ? 'GoalTimelock' : 'TokenTimelock (OpenZeppelin)') + '<br><a href="https://arbiscan.io/address/' + l.addr + '" target="_blank" rel="noopener noreferrer">Open on Arbiscan</a></div>' + (l.balance === 0n ? '<button class="btn ghost small" data-hide="' + l.addr + '" style="margin-top:10px">Hide this lock</button>' : '') + '</details>';
      if (account && account === l.beneficiary) {
        const row = document.createElement('div'); row.className = 'row';
        if (s.ready) {
          const r = document.createElement('button'); r.className = 'btn'; r.textContent = 'Withdraw ' + num(fmt(l.balance)) + ' ' + l.sym + ' to my wallet';
          r.onclick = () => run(r, async () => { await ensureArbitrum(); await guard.release({ lock: l.addr }); toast('Done! The money is back in your wallet.'); });
          row.appendChild(r);
        }
        if (!s.timeUp) {
          const d = document.createElement('button'); d.className = g ? 'btn brass' : 'btn ghost'; d.textContent = 'Add money';
          d.onclick = () => openDeposit(l); row.appendChild(d);
        }
        if (row.children.length) el.appendChild(row);
      }
      box.appendChild(el);
    }
    if (finished.length) {
      if (!LOCKS.some((l) => !isFinished(l))) box.innerHTML = '<div class="empty"><b>No active locks.</b><br>Tap <b>New lock</b> below to start your next goal.</div>';
      const f = document.createElement('details'); f.className = 'rejected';
      f.innerHTML = '<summary>Finished (' + finished.length + ')</summary>' + finished.map((l) => '<div class="small">' + esc(l.name || (l.kind === 'goal' ? num(fmt(l.goal)) + ' ' + l.sym + ' goal' : l.sym + ' lock')) + ': ' + (Date.now() / 1000 >= l.releaseTime ? 'ended ' + dateStr(l.releaseTime) : 'withdrawn') + ', nothing left inside. <a href="https://arbiscan.io/address/' + l.addr + '" target="_blank" rel="noopener noreferrer">View</a> · <a href="#" data-hide="' + l.addr + '">Hide</a></div>').join('');
      box.appendChild(f);
    }
    openAddrs.forEach((a) => { const d = box.querySelector('article[data-addr="' + a + '"] details'); if (d) d.open = true; });
    box.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', (ev) => {
      ev.preventDefault(); const w = viewer(); if (!w) return;
      const lst = store.json(hiddenKey(w), []); lst.push(b.dataset.hide.toLowerCase()); store.setJson(hiddenKey(w), [...new Set(lst)]);
      toast('Hidden. You can show it again in Settings.'); refresh();
    }));
    if (rej.length) {
      const r = document.createElement('details'); r.className = 'rejected';
      r.innerHTML = '<summary>' + rej.length + ' address' + (rej.length > 1 ? 'es' : '') + ' hidden: not a genuine TimeVault lock for this wallet</summary>' + rej.map(([a, why]) => '<div class="small"><span class="mono">' + esc(a) + '</span><br>' + esc(why) + '</div>').join('');
      box.appendChild(r);
    }
  }

  async function run(btn, fn) {
    const t = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    const stopped = new Promise((_, rej) => { stopWait = () => rej(new TV.Refused('Stopped waiting. If you still approve it in your wallet, it can go through, so check your savings before trying again.')); });
    try { await Promise.race([fn(), stopped]); } catch (e) { toast(nice(e), 10000); } finally { stopWait = null; waiting(false); btn.disabled = false; btn.textContent = t; historyAt = 0; lastSig = ''; refresh(); }
  }

  // ------------------------------------------------------------------ deposit sheet
  let depLock = null;
  function openDeposit(l, amount) {
    depLock = l; $('depTitle').textContent = 'Add money to ' + (l.name || (l.kind === 'goal' ? 'your ' + num(fmt(l.goal)) + ' ' + l.sym + ' goal' : 'your lock'));
    $('depAmount').value = amount || ''; $('depBal').textContent = WALLET[l.sym] !== undefined ? 'You have ' + num(fmt(WALLET[l.sym]), 6) + ' ' + l.sym + ' in your wallet.' : '';
    $('exCoin').textContent = l.sym; $('exAddr').textContent = l.addr; $('exContract').textContent = '\u2026' + l.token.slice(-4) + ' (full: ' + l.token + ')';
    $('exQr').hidden = true; $('exQr').innerHTML = ''; exBase = null; exStop();
    depTab(false); $('depSheet').hidden = false;
  }
  // ---- add money from an exchange: show the lock address and watch for coins arriving
  let exBase = null, exTimer = null;
  function exStop() { clearInterval(exTimer); exTimer = null; $('exWatch').className = 'exwatch'; $('exWatch').textContent = 'Waiting for money to arrive\u2026'; }
  async function exPoll() {
    if (!depLock || $('depSheet').hidden) return exStop();
    try {
      const b = await new ethers.Contract(depLock.token, ERC20, main).balanceOf(depLock.addr);
      if (exBase === null) exBase = b;
      else if (b > exBase) { $('exWatch').className = 'exwatch got'; $('exWatch').textContent = 'Arrived: +' + num(fmt(b - exBase), 6) + ' ' + depLock.sym + '. It is locked now.'; history = null; }
    } catch {}
  }
  function depTab(ex) {
    $('depTabWallet').setAttribute('aria-selected', String(!ex)); $('depTabEx').setAttribute('aria-selected', String(ex));
    $('depWallet').hidden = ex; $('depEx').hidden = !ex;
    if (ex && !exTimer) { exPoll(); exTimer = setInterval(exPoll, 8000); } else if (!ex) exStop();
    if (!ex) $('depAmount').focus();
  }
  $('depTabWallet').addEventListener('click', () => depTab(false));
  $('depTabEx').addEventListener('click', () => depTab(true));
  $('exCopy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(depLock.addr); toast('Lock address copied. Pick ' + depLock.sym + ' on the Arbitrum One network.', 8000); } catch { toast('Select the address and copy it.'); } });
  $('exQrBtn').addEventListener('click', () => { try { const q = qrcode(0, 'M'); q.addData(depLock.addr); q.make(); $('exQr').innerHTML = q.createImgTag(4, 8); $('exQr').hidden = false; } catch { toast('QR code not available. Use Copy address.'); } });
  const closeDep = () => { $('depSheet').hidden = true; exStop(); if ($('exWatch').classList.contains('got')) refresh(); };
  $('exClose').addEventListener('click', () => { $('depSheet').hidden = true; exStop(); refresh(); });
  $('depClose').addEventListener('click', closeDep);
  $('depMax').addEventListener('click', () => { if (depLock && WALLET[depLock.sym] !== undefined) $('depAmount').value = ethers.formatUnits(WALLET[depLock.sym], 6); });
  $('depGo').addEventListener('click', () => {
    const l = depLock; const raw = $('depAmount').value.trim();
    let amt; try { amt = ethers.parseUnits(raw || '0', 6); } catch { return toast('Enter an amount like 25 or 25.50'); }
    if (amt <= 0n) return toast('Enter an amount.');
    $('depSheet').hidden = true; // close this sheet first so the confirm screen is visible on top
    run($('depGo'), async () => {
      await ensureArbitrum();
      const after = await guard.deposit({ lock: l.addr, amount: amt });
      toast(after.kind === 'goal' && after.balance >= after.goal ? 'Goal reached! You can withdraw it now.' : 'Added ' + raw + ' ' + l.sym + '. Nice work!');
      history = null;
    });
  });

  // ------------------------------------------------------------------ new lock
  const lockType = () => ($('typeGoal').checked ? 'goal' : 'date');
  function setDate(d) { $('lkDate').value = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); updateSummary(); }
  document.querySelectorAll('[data-months]').forEach((b) => b.addEventListener('click', () => { const d = new Date(); d.setMonth(d.getMonth() + Number(b.dataset.months)); setDate(d); }));
  document.querySelectorAll('[data-days]').forEach((b) => b.addEventListener('click', () => { const d = new Date(); d.setDate(d.getDate() + Number(b.dataset.days)); setDate(d); }));
  document.querySelectorAll('[data-goal]').forEach((b) => b.addEventListener('click', () => { $('lkGoal').value = b.dataset.goal; updateSummary(); }));
  ['typeGoal', 'typeDate'].forEach((id) => $(id).addEventListener('change', applyType));
  ['lkName', 'lkToken', 'lkAmount', 'lkDate', 'lkAgree', 'lkGoal'].forEach((id) => $(id).addEventListener('input', updateSummary));
  $('lkMax').addEventListener('click', () => { const b = WALLET[$('lkToken').value]; if (b !== undefined) { $('lkAmount').value = ethers.formatUnits(b, 6); updateSummary(); } });
  function applyType() {
    const g = lockType() === 'goal';
    $('goalField').hidden = !g; $('amountLabel').textContent = g ? 'Add money now (optional)' : 'How much to lock';
    $('dateLabel').textContent = g ? 'Backup date' : 'Unlock date'; $('dateHint').hidden = !g;
    if (!$('lkDate').value) { const d = new Date(); d.setMonth(d.getMonth() + (g ? 24 : 6)); setDate(d); }
    updateSummary();
  }
  function unlockTs() {
    const v = $('lkDate').value; if (!v) return 0;
    const [y, mo, d] = v.split('-').map(Number); const n = new Date();
    return Math.floor(new Date(y, mo - 1, d, n.getHours(), n.getMinutes() + 5, 0).getTime() / 1000);
  }
  function parse6(v) { try { return v.trim() ? ethers.parseUnits(v.trim(), 6) : 0n; } catch { return null; } }
  function updateSummary() {
    const g = lockType() === 'goal', sym = $('lkToken').value;
    const amt = parse6($('lkAmount').value), goal = parse6($('lkGoal').value), ts = unlockTs();
    const bal = WALLET[sym];
    $('lkBal').textContent = bal !== undefined ? 'You have ' + num(fmt(bal), 6) + ' ' + sym + ' in your wallet.' : '';
    const days = ts ? (ts - Date.now() / 1000) / DAY : 0;
    const warn = [], todo = [], caution = [];
    if (amt === null) warn.push('Enter the amount as a number, like 25 or 25.50.');
    if (g && goal === null) warn.push('Enter your goal as a number, like 1000.');
    if (!g && amt === 0n) todo.push('Enter how much to lock.');
    if (g && goal === 0n) todo.push('Pick a goal.');
    if (ts && days < 0.9) warn.push('Pick a date at least one day from now.');
    if (days > 3650) warn.push('The date can be at most 10 years from now.');
    if (bal !== undefined && amt && amt > bal) warn.push('That is more ' + sym + ' than you have in your wallet.');
    else if (bal !== undefined && amt && amt * 10n > bal * 8n) caution.push('You are locking most of your ' + sym + '. Keep enough outside for the next month or two.');
    if (g && goal && amt && amt >= goal) warn.push('This amount already reaches your goal, so the lock would open straight away. Pick a bigger goal.');
    if (!account) todo.push('Connect your wallet (button at the top).');
    if (!SELF.ok) warn.push('Safety check failed. Do not use this copy of the app.');
    const ok = !warn.length && !todo.length && ts && $('lkAgree').checked;
    const goalTxt = goal ? num(fmt(goal)) + ' ' + sym : 'your goal';
    $('lkSummary').innerHTML = [
      g ? '<b>Goal:</b> ' + goalTxt : '<b>Locking:</b> ' + (amt ? num(fmt(amt), 6) : '—') + ' ' + sym,
      g ? '<b>Adding now:</b> ' + (amt ? num(fmt(amt), 6) + ' ' + sym : 'nothing yet, add money later') : '',
      ts ? (g ? '<b>Opens:</b> when it reaches ' + goalTxt + ', or on ' + dateStr(ts) + ' if that comes first' : '<b>Opens:</b> ' + dateStr(ts) + ' (in ' + Math.round(days) + ' days)') : '',
      '<b>Pays out to:</b> ' + (account ? 'your wallet <span class="mono">' + short(account) + '</span>' : 'your wallet'),
      ...todo.map((w) => '<span class="muted">→ ' + esc(w) + '</span>'),
      ...caution.map((w) => '<span class="caution">● ' + esc(w) + '</span>'),
      ...warn.map((w) => '<span class="warn">⚠ ' + esc(w) + '</span>'),
    ].filter(Boolean).map((x) => '<div>' + x + '</div>').join('');
    $('lkAgreeText').textContent = g
      ? 'I understand that nobody, not even me, can take this money out until it reaches ' + goalTxt + (ts ? ' or ' + dateStr(ts) + ' arrives' : '') + '.'
      : 'I understand that nobody, not even me, can take this money out before ' + (ts ? dateStr(ts) : 'the date') + '.';
    $('lkGo').disabled = !ok;
  }
  const step = (n, s) => { $('st' + n).className = s; };
  $('lkGo').addEventListener('click', () => {
    const g = lockType() === 'goal', sym = $('lkToken').value;
    const amt = parse6($('lkAmount').value) || 0n, goal = g ? parse6($('lkGoal').value) : undefined, ts = unlockTs();
    const name = $('lkName').value.trim().slice(0, 40);
    $('lkSteps').hidden = false; [1, 2, 3].forEach((n) => step(n, ''));
    $('st3').textContent = amt > 0n ? 'Add ' + num(fmt(amt), 6) + ' ' + sym + ' to the lock (approve in your wallet)' : 'No money added yet. Use Add money on the Savings screen any time.';
    run($('lkGo'), async () => {
      await ensureArbitrum();
      const startBlock = await main.getBlockNumber().catch(() => 0);
      step(1, 'doing');
      const L = await guard.create({ kind: g ? 'goal' : 'date', sym, releaseTime: ts, goal, onStep: (s) => { if (s === 'verify') { step(1, 'done'); step(2, 'doing'); waiting(false); } } });
      addLock(account, { addr: L.addr, created: Math.floor(Date.now() / 1000), block: startBlock, name }); store.set('ms.' + L.addr.toLowerCase(), '0');
      verified.set(L.addr, L); step(2, 'done');
      if (amt > 0n) { step(3, 'doing'); await guard.deposit({ lock: L.addr, amount: amt }); }
      step(3, 'done');
      toast(g ? 'Your savings goal is ready!' : 'Locked until ' + dateStr(ts) + '.', 8000);
      $('lkAmount').value = ''; $('lkAgree').checked = false; $('lkName').value = '';
      if (g && !store.get('plan.target')) store.set('plan.target', L.addr);
      show('home');
    });
  });

  // ------------------------------------------------------------------ find my locks (deposit history from this wallet)
  async function getLogsRetry(q) { // try each server in turn; a missing answer must not look like "no deposits"
    let last;
    for (const pv of providers) { try { return await pv.send('eth_getLogs', [q]); } catch (e) { last = e; } }
    throw last;
  }
  async function transferLogs(from, toList, windows, progress, onlyToken) {
    const head = await main.getBlockNumber(); const WIN = 9_900_000; const out = [];
    const topic0 = ethers.id('Transfer(address,address,uint256)'), fromT = from ? ethers.zeroPadValue(from, 32) : null;
    const toT = toList ? toList.map((a) => ethers.zeroPadValue(a, 32)) : null;
    for (let w = 0; w < windows; w++) {
      const to = head - w * WIN, fromB = Math.max(0, to - WIN + 1); if (to <= 0) break;
      for (const t of Object.values(TOKENS)) {
        if (onlyToken && t.address.toLowerCase() !== onlyToken.toLowerCase()) continue;
        const q = { address: t.address, topics: toT ? [topic0, fromT, toT] : [topic0, fromT], fromBlock: ethers.toQuantity(fromB), toBlock: ethers.toQuantity(to) };
        const logs = onlyToken ? await getLogsRetry(q) : await main.send('eth_getLogs', [q]).catch(() => []);
        out.push(...logs);
      }
      if (progress) $('findBtn').textContent = 'Searching ' + Math.round((w + 1) / windows * 100) + '%…';
    }
    return out;
  }
  $('findBtn').addEventListener('click', async () => {
    const who = viewer(); if (!who) return toast('Connect your wallet first.');
    const b = $('findBtn'); b.disabled = true;
    try {
      const logs = await transferLogs(who, null, 28, true);
      const cands = [...new Set(logs.map((l) => ethers.getAddress('0x' + l.topics[2].slice(26))))];
      let found = 0;
      for (const a of cands) {
        if (isHidden(who, a) || getList(who).some((e) => e.addr.toLowerCase() === a.toLowerCase())) continue;
        const code = await main.getCode(a).catch(() => '0x');
        if (code.length !== 2 + 1737 * 2 && code.length !== 2 + 1639 * 2) continue;
        try { await verifyCached(a, who); addLock(who, { addr: a }); found++; } catch {}
      }
      toast(found ? 'Found ' + found + ' lock' + (found > 1 ? 's' : '') + '.' : 'No other locks found. Locks you never added money to can only be added by address in Settings.', 8000);
      refresh();
    } catch (e) { toast('Search failed: ' + nice(e)); } finally { b.disabled = false; b.textContent = 'Find my locks'; }
  });
  $('addLockBtn').addEventListener('click', async () => {
    const who = viewer(), v = $('addLock').value.trim();
    if (!who) return toast('Connect or track a wallet first.');
    try { const L = await TV.verifyLock(ethers, verifyCfg, v, { beneficiary: who }); verified.set(L.addr, L); addLock(who, { addr: L.addr }); $('addLock').value = ''; toast('Checked: it is a genuine lock for your wallet. Added.'); refresh(); }
    catch (e) { toast(nice(e), 8000); }
  });
  $('unhideBtn').addEventListener('click', () => { const w = viewer(); if (!w) return toast('Connect your wallet first.'); const n = store.json(hiddenKey(w), []).length; store.set(hiddenKey(w), ''); toast(n ? 'Showing ' + n + ' hidden lock' + (n > 1 ? 's' : '') + ' again.' : 'No hidden locks.'); refresh(); });
  $('exportBtn').addEventListener('click', () => {
    const who = viewer(); if (!who) return toast('Connect or track a wallet first.');
    const data = { app: 'TimeVault', wallet: who, network: 'Arbitrum One', exported: new Date().toISOString(), locks: LOCKS.map((l) => ({ address: l.addr, type: l.kind, coin: l.sym, goal: l.kind === 'goal' ? ethers.formatUnits(l.goal, 6) : null, unlock: new Date(l.releaseTime * 1000).toISOString(), name: l.name })) };
    download('timevault-backup.json', JSON.stringify(data, null, 2), 'application/json');
  });

  // ------------------------------------------------------------------ coach: payday plan
  const PLAN = () => ({ pay: Number(store.get('plan.pay', '0')), freq: store.get('plan.freq', 'monthly'), next: store.get('plan.next', ''), mode: store.get('plan.mode', 'pct'), pct: Number(store.get('plan.pct', '20')), fixed: Number(store.get('plan.fixed', '0')), target: store.get('plan.target', '') });
  function saveAmount(p) { return p.mode === 'pct' ? Math.round(p.pay * p.pct) / 100 : p.fixed; }
  // Paydays as Date objects (local midnight)
  function payday(p, k) { // k-th payday relative to the anchor (k can be negative)
    const [y, m, d] = p.next.split('-').map(Number); const a = new Date(y, m - 1, d);
    if (p.freq === 'weekly' || p.freq === 'biweekly') { const step = p.freq === 'weekly' ? 7 : 14; const r = new Date(a); r.setDate(a.getDate() + k * step); return r; }
    if (p.freq === 'monthly') { const r = new Date(a.getFullYear(), a.getMonth() + k, 1); r.setDate(Math.min(d, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate())); return r; }
    // twice a month: 1st and 15th, k counts half-months from the anchor's half
    const half = a.getDate() >= 15 ? 1 : 0; const idx = a.getMonth() * 2 + half + k + a.getFullYear() * 24;
    const yy = Math.floor(idx / 24), mm = Math.floor((idx % 24) / 2), hh = idx % 2;
    return new Date(yy, mm, hh ? 15 : 1);
  }
  function lastAndNext(p) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    let k = 0; while (payday(p, k) > today) k--; while (payday(p, k + 1) <= today) k++;
    return { last: payday(p, k), next: payday(p, k + 1), k };
  }
  ['cPay', 'cFreq', 'cNext', 'cMode', 'cPct', 'cFixed', 'cTarget'].forEach((id) => $(id).addEventListener('input', () => {
    store.set('plan.pay', $('cPay').value); store.set('plan.freq', $('cFreq').value); store.set('plan.next', $('cNext').value);
    store.set('plan.mode', $('cMode').value); store.set('plan.pct', $('cPct').value); store.set('plan.fixed', $('cFixed').value); store.set('plan.target', $('cTarget').value);
    renderCoach(); renderToday(); planChanged();
  }));
  function planReady(p) { return p.next && saveAmount(p) > 0; }
  function renderCoach() {
    const p = PLAN();
    $('cPctRow').hidden = p.mode !== 'pct'; $('cFixedRow').hidden = p.mode !== 'fixed';
    const out = $('cPlan');
    if (!planReady(p)) { out.innerHTML = '<p class="muted">Fill in your pay and next payday to get a plan.</p>'; return; }
    const S = saveAmount(p); const L = LOCKS.find((l) => l.addr === p.target);
    const rows = ['<div><b>Each payday:</b> lock ' + money(S) + (p.mode === 'pct' ? ' (' + p.pct + '% of ' + money(p.pay) + ')' : '') + '</div>'];
    const perYear = { weekly: 52, biweekly: 26, twice: 24, monthly: 12 }[p.freq];
    rows.push('<div><b>In a year:</b> ' + money(S * perYear) + '</div>');
    if (L) {
      const left = Math.max(0, fmt(L.goal) - fmt(L.balance));
      if (left === 0) rows.push('<div class="ok-text"><b>Goal reached!</b> Withdraw it on the Savings screen, then set your next goal.</div>');
      else {
        const n = Math.ceil(left / S); const { k } = lastAndNext(p); const when = payday(p, k + n);
        rows.push('<div><b>' + money(left) + ' to go:</b> about ' + n + ' more payday' + (n > 1 ? 's' : '') + ', around ' + dayStr(when) + '</div>');
        const backup = new Date(L.releaseTime * 1000); let m = 0; while (payday(p, k + m + 1) < backup && m < 2000) m++;
        if (m > 0 && when > backup) rows.push('<div class="warn">⚠ At this pace you will not reach it before the backup date (' + dateStr(L.releaseTime) + '). To make it, lock about ' + money(Math.ceil(left / m * 100) / 100) + ' each payday.</div>');
      }
    } else rows.push('<div class="muted">Choose a goal above to see when you will reach it. No goal yet? Make one in New lock.</div>');
    out.innerHTML = rows.join('');
  }
  function renderToday() {
    const p = PLAN(); const box = $('today');
    if (!viewer() || !planReady(p)) { box.innerHTML = '<div class="today-empty"><b>Make a payday plan</b><span>Tell the coach when you get paid. It tells you how much to lock each payday and reminds you.</span><button class="btn ghost small" data-go="coach">Make my plan</button></div>'; bindGo(box); return; }
    const { last, next } = lastAndNext(p); const S = saveAmount(p);
    const L = LOCKS.find((l) => l.addr === p.target);
    const since = history ? history.filter((h) => h.time * 1000 >= last.getTime() && (!p.target || h.to === p.target)) : null;
    const done = since && since.length > 0;
    const isToday = last.toDateString() === new Date().toDateString();
    let html;
    if (done) html = '<div class="today-ok"><span class="big-check">✓</span><div><b>Saved this pay period.</b><span>Next payday: ' + dayStr(next) + '. ' + streakText() + '</span></div></div>';
    else html = '<div class="today-due"><div><span class="label">' + (isToday ? 'Payday today' : 'Since payday ' + dayStr(last)) + '</span><b>Lock ' + money(S) + (L ? ' into your ' + num(fmt(L.goal)) + ' ' + L.sym + ' goal' : '') + '</b><span>' + streakText() + '</span></div>' +
      (L && account ? '<button class="btn brass" id="todayGo">Lock ' + money(S) + '</button>' : '') + '</div>';
    box.innerHTML = html;
    const go = $('todayGo'); if (go) go.onclick = () => openDeposit(L, String(S));
  }
  function bindGo(root) { root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => show(b.dataset.go))); }
  $('icsBtn').addEventListener('click', () => {
    const p = PLAN(); if (!planReady(p)) return toast('Fill in your payday plan first.');
    const [y, m, d] = p.next.split('-');
    const rule = { weekly: 'FREQ=WEEKLY', biweekly: 'FREQ=WEEKLY;INTERVAL=2', twice: 'FREQ=MONTHLY;BYMONTHDAY=1,15', monthly: 'FREQ=MONTHLY;BYMONTHDAY=' + Number(d) }[p.freq];
    const start = p.freq === 'twice' ? (Number(d) >= 15 ? y + m + '15' : y + m + '01') : y + m + d;
    const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TimeVault//Coach//EN', 'BEGIN:VEVENT', 'UID:timevault-payday-' + Date.now() + '@timevault',
      'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z', 'DTSTART:' + start + 'T090000', 'RRULE:' + rule,
      'SUMMARY:Payday: lock ' + money(saveAmount(p)) + ' in TimeVault', 'DESCRIPTION:Open TimeVault and tap Lock on the home screen.',
      'BEGIN:VALARM', 'TRIGGER:PT0M', 'ACTION:DISPLAY', 'DESCRIPTION:Payday: lock your savings', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    download('timevault-payday.ics', ics, 'text/calendar');
    toast('Open the downloaded file to add the reminders to your calendar.');
  });
  async function download(name, text, type) {
    if (NATIVE) { // the Android app cannot save files from a web page, so copy instead
      try { await navigator.clipboard.writeText(text); toast('Copied to your clipboard. Paste it into a note or email to keep it.', 8000); }
      catch { toast('Could not copy. Use the website version to download this file.'); }
      return;
    }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; document.body.appendChild(a); a.click(); a.remove(); }

  // ------------------------------------------------------------------ coach: history + streak (from the blockchain, not this device)
  let history = null, historyFor = '', historyFailed = false;
  // Deposits into each lock, cached per lock: after the first full look-back, only new blocks are fetched.
  const HWIN = 9_900_000, HWINDOWS = 13;
  const histKey = (a) => 'h.' + a.toLowerCase();
  function buildHistory(who) {
    const me = ethers.getAddress(who);
    return LOCKS.flatMap((l) => (store.json(histKey(l.addr), null)?.items || []).map((h) => ({ ...h, amount: BigInt(h.amount), fromMe: h.from === me })))
      .filter((h) => LOCKS.some((l) => l.addr === h.to && l.sym === h.sym)) // only the lock's own coin counts
      .sort((a, b) => b.time - a.time);
  }
  async function lockHistory(l, head) {
    const c = store.json(histKey(l.addr), null);
    const oldest = Math.max(0, head - HWINDOWS * HWIN + 1);
    const from = c ? Math.max(c.upTo + 1, oldest) : oldest;
    if (from > head) return;
    const topic0 = ethers.id('Transfer(address,address,uint256)'), toT = ethers.zeroPadValue(l.addr, 32);
    const found = [];
    for (let hi = head; hi >= from; hi -= HWIN) { // one lock per request: servers only allow long ranges for a single address
      const lo = Math.max(from, hi - HWIN + 1);
      found.push(...await getLogsRetry({ address: l.token, topics: [topic0, null, toT], fromBlock: ethers.toQuantity(lo), toBlock: ethers.toQuantity(hi) }));
    }
    const items = c ? c.items.slice() : [];
    for (const lg of found) {
      if (items.some((x) => x.tx === lg.transactionHash && x.li === lg.logIndex)) continue;
      const blk = await main.getBlock(Number(lg.blockNumber)).catch(() => null);
      items.push({ to: ethers.getAddress('0x' + lg.topics[2].slice(26)), from: ethers.getAddress('0x' + lg.topics[1].slice(26)), sym: SYMBOL[lg.address.toLowerCase()], amount: String(BigInt(lg.data)), time: blk ? blk.timestamp : 0, tx: lg.transactionHash, li: lg.logIndex });
    }
    store.setJson(histKey(l.addr), { upTo: head, items });
  }
  let historyAt = 0, historyLoaded = false;
  async function loadHistory(fromCacheOnly) {
    const who = viewer(); if (!who || !LOCKS.length) { history = []; renderHistory(); return; }
    if (fromCacheOnly || !history) { history = buildHistory(who); renderHistory(); renderToday(); }
    if (fromCacheOnly) return;
    const key = who + LOCKS.map((l) => l.addr).join();
    if (historyFor === key && Date.now() - historyAt < 50000) return;
    historyFor = key; historyAt = Date.now();
    const before = (history || []).length;
    try {
      const head = await main.getBlockNumber();
      await Promise.all(LOCKS.map((l) => lockHistory(l, head)));
    } catch { historyFor = ''; historyFailed = true; renderHistory(); return; }
    historyFailed = false; historyLoaded = true;
    history = buildHistory(who);
    renderHistory(); renderToday(); if (history.length !== before) renderLocks();
  }
  function streak() {
    const p = PLAN(); if (!history || !planReady(p)) return 0;
    const { k } = lastAndNext(p); let s = 0;
    for (let i = 0; i < 200; i++) {
      const a = payday(p, k - i), b = payday(p, k - i + 1);
      const hit = history.some((h) => h.time * 1000 >= a.getTime() && h.time * 1000 < b.getTime());
      if (hit) s++; else if (i === 0) continue; else break;
    }
    return s;
  }
  function streakText() { const s = streak(); return s ? 'Streak: ' + s + ' payday' + (s > 1 ? 's' : '') + ' in a row.' : 'Start your streak this payday.'; }
  function renderHistory() {
    const box = $('history');
    if (!history || (!history.length && !historyLoaded)) { box.innerHTML = '<p class="muted">' + (historyFailed ? 'Could not load your deposits right now. It will try again in a minute.' : 'Loading your deposits from the blockchain…') + '</p>'; return; }
    if (!history.length) { box.innerHTML = '<p class="muted">No deposits yet. Your first one starts the streak.</p>'; return; }
    const total = history.reduce((s, h) => s + fmt(h.amount), 0);
    $('streakNum').textContent = String(streak());
    box.innerHTML = '<div class="small muted">' + history.length + ' deposits · ' + money(total) + ' saved in the last year</div>' +
      '<ol class="hist">' + history.slice(0, 12).map((h) => '<li><span>' + dateStr(h.time) + (h.fromMe ? '' : ' <span class="muted small">from exchange or other</span>') + '</span><b>+' + num(fmt(h.amount)) + ' ' + h.sym + '</b><a class="mono small" target="_blank" rel="noopener noreferrer" href="https://arbiscan.io/tx/' + h.tx + '">view</a></li>').join('') + '</ol>';
  }

  // ------------------------------------------------------------------ coach: lessons
  const LESSONS = [
    ['Pay yourself first', 'Lock your savings the day you get paid, before you spend anything. Saving what is left at the end of the month usually means saving nothing.'],
    ['Start with an emergency fund', 'Aim for about 3 months of living costs that you can reach quickly. Keep that part flexible, not in a long lock. Lock the money beyond it.'],
    ['Small and steady beats big and rare', 'Locking a fixed amount every payday builds the habit. The streak counter is here to help you keep going.'],
    ['The 24-hour rule', 'Want to buy something you did not plan for? Wait a day. Most urges pass. If you still want it tomorrow, decide then.'],
    ['Why a lock helps', 'Willpower runs out. A lock removes the choice, so the decision you made calmly is the one that sticks.'],
    ['Stablecoins are not a bank account', 'USDC and USDT aim to stay at $1, but they are run by companies (Circle, Tether) that can freeze addresses. Spread large savings across more than one place.'],
    ['Scams to watch for', 'No real app will ask for your recovery phrase. Only open TimeVault from your saved home-screen icon, never from a link someone sends you.'],
    ['Locked means locked', 'TimeVault has no early exit, on purpose. Before you lock, ask: could I need this money before the goal or the date? If yes, lock less.'],
    ['Keep a small buffer', 'Even living at home, things come up: a broken phone, a family need, a good opportunity. Keep 1 to 2 months of your spending outside the lock, and lock the rest.'],
    ['Look-alike address scams', 'Scammers send you tiny amounts from addresses that start and end like yours or your lock\'s, hoping you copy the fake one from your history. Never copy an address from history. Copy it from TimeVault, and check the whole address.'],
    ['Pick realistic goals', 'A goal you can reach in 3 to 6 months keeps you motivated. When you hit it, set the next one a bit higher.'],
  ];
  function renderLessons() {
    const read = new Set(store.json('lessons.read', []));
    $('lessons').innerHTML = LESSONS.map(([t, b], i) => '<details class="lesson' + (read.has(i) ? ' read' : '') + '" data-i="' + i + '"><summary>' + (read.has(i) ? '✓ ' : '') + esc(t) + '</summary><p>' + esc(b) + '</p></details>').join('');
    $('lessons').querySelectorAll('details').forEach((d) => d.addEventListener('toggle', () => { if (d.open) { const r = new Set(store.json('lessons.read', [])); r.add(Number(d.dataset.i)); store.setJson('lessons.read', [...r]); } }));
    $('lessonCount').textContent = read.size + ' / ' + LESSONS.length + ' read';
  }

  // ------------------------------------------------------------------ safety screen
  async function renderSelf() {
    $('selfList').innerHTML = SELF.items.map((i) => '<li class="' + (i.ok ? 'ok' : 'bad') + '">' + (i.ok ? '✓ ' : '✗ ') + esc(i.label) + '</li>').join('');
    $('selfBanner').hidden = SELF.ok; $('safeOk').hidden = !SELF.ok;
  }
  async function codeFingerprints() {
    const out = [];
    for (const id of ['coreScript', 'appScript']) {
      const t = $(id).textContent; const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
      out.push((id === 'coreScript' ? 'Safety core' : 'App screens') + ': sha256-' + btoa(String.fromCharCode(...new Uint8Array(h))));
    }
    $('appFp').textContent = out.join('\n');
  }
  $('liveCheck').addEventListener('click', async () => {
    const who = viewer(); const box = $('liveOut');
    if (!who || !LOCKS.length) { box.textContent = 'You have no locks to check yet.'; return; }
    box.textContent = 'Checking every lock on 4 independent servers. This takes a few seconds…';
    const lines = [];
    for (const l of LOCKS) {
      try { await TV.verifyLock(ethers, { providers, need: 3, tokens: TOKENS }, l.addr, { beneficiary: who }); lines.push('✓ ' + (l.name || short(l.addr)) + ': genuine, pays only ' + short(who)); }
      catch (e) { lines.push('✗ ' + short(l.addr) + ' · ' + e.message); }
    }
    box.textContent = lines.join('\n');
  });
  $('dlVerifyGoal').addEventListener('click', () => verifyFile('goal'));
  $('dlVerifyDate').addEventListener('click', () => verifyFile('date'));
  function verifyFile(kind) {
    const settings = { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode', 'evm.deployedBytecode', 'metadata'] } } };
    const oz = window.TV_SOURCES.oz; const sources = {};
    if (kind === 'goal') { sources['GoalTimelock.sol'] = { content: window.TV_SOURCES.goal }; for (const [k, v] of Object.entries(oz)) if (!k.endsWith('TokenTimelock.sol')) sources[k] = { content: v }; }
    else for (const [k, v] of Object.entries(oz)) sources[k] = { content: v };
    const json = JSON.stringify({ language: 'Solidity', sources, settings });
    const want = kind === 'goal' ? '0x6e241b46e0bb9f680568d5e76ff304d15a465f872012b2787379c8b3b9c53f54' : '0x7055f9455e96e667fec83ab5536c27b6a68f072245b55f70a47fbabdac332838';
    if (ethers.keccak256(ethers.toUtf8Bytes(json)) !== want) return toast('Source fingerprint mismatch. Not saving.');
    download((kind === 'goal' ? 'GoalTimelock' : 'TokenTimelock') + '-verify.json', json, 'application/json');
  }

  // ------------------------------------------------------------------ payday notifications (Android app only)
  // Schedules the next 26 paydays at 9:00 as one-time phone notifications. Rescheduled whenever the plan changes or the app opens.
  function notifyNote(t) { $('notifyNote').textContent = t; $('notifyNote').hidden = !t; }
  async function scheduleNotifications(ask) {
    if (!LN) return;
    try {
      let perm = await LN.checkPermissions();
      if (perm.display !== 'granted' && ask) perm = await LN.requestPermissions();
      if (perm.display !== 'granted') {
        $('notifyBtn').hidden = false;
        notifyNote(ask ? 'Notifications are blocked. Turn them on in Android Settings \u2192 Apps \u2192 TimeVault \u2192 Notifications.' : '');
        return;
      }
      store.set('notify', '1'); $('notifyBtn').hidden = true;
      const pending = await LN.getPending();
      if (pending.notifications.length) await LN.cancel({ notifications: pending.notifications.map((n) => ({ id: Number(n.id) })) });
      const p = PLAN(); const list = []; const now = Date.now();
      if (planReady(p)) {
        const { k } = lastAndNext(p); const S = money(saveAmount(p));
        for (let i = 0; list.length < 26 && i < 80; i++) {
          const d = payday(p, k + i); d.setHours(9, 0, 0, 0);
          if (d.getTime() > now + 60000) list.push({ id: 1000 + list.length, title: 'Payday: lock ' + S, body: 'Open TimeVault and tap Lock to keep your streak going.', schedule: { at: d, allowWhileIdle: true } });
        }
      }
      // reminders the day before and the moment a lock opens (date locks, and goal locks' backup dates)
      let n = 0;
      for (const l of LOCKS) {
        if (n >= 40 || l.balance === 0n) continue;
        const name = l.name || (l.kind === 'goal' ? 'your ' + num(fmt(l.goal)) + ' ' + l.sym + ' goal' : 'your ' + l.sym + ' lock');
        const open = new Date(l.releaseTime * 1000), before = new Date(open.getTime() - 86400000);
        const what = l.kind === 'goal' ? 'reaches its backup date' : 'opens';
        if (before.getTime() > now + 60000) list.push({ id: 2000 + n++, title: 'Tomorrow: ' + name + ' ' + what, body: 'It holds ' + num(fmt(l.balance)) + ' ' + l.sym + '.', schedule: { at: before, allowWhileIdle: true } });
        if (open.getTime() > now + 60000) list.push({ id: 2000 + n++, title: name.charAt(0).toUpperCase() + name.slice(1) + ' is open', body: 'You can withdraw ' + num(fmt(l.balance)) + ' ' + l.sym + ' in TimeVault, or leave it and keep saving.', schedule: { at: open, allowWhileIdle: true } });
      }
      if (list.length) await LN.schedule({ notifications: list });
      const nextPay = list.find((x) => x.id < 2000);
      notifyNote(nextPay ? 'Reminders on. Next payday reminder: ' + dayStr(nextPay.schedule.at) + ' at 9:00. You will also get a reminder before each lock opens.'
        : list.length ? 'Reminders on for when your locks open. Fill in your plan above to also get payday reminders.'
        : 'Reminders are on. Fill in your plan above to get payday reminders.');
    } catch (e) { notifyNote('Could not set notifications: ' + nice(e)); }
  }
  let planT;
  function planChanged() { if (LN && store.get('notify') === '1') { clearTimeout(planT); planT = setTimeout(() => scheduleNotifications(false), 1500); } }
  $('notifyBtn').addEventListener('click', () => scheduleNotifications(true));
  if (LN) { $('icsBtn').hidden = true; $('notifyBtn').hidden = store.get('notify') === '1'; }

  // ------------------------------------------------------------------ boot
  bindGo(document);
  $('dialTicks').innerHTML = Array.from({ length: 60 }, (_, i) => { const a = i / 60 * 2 * Math.PI, r1 = i % 5 ? 50 : 48, r2 = 54; return '<line' + (i % 5 ? '' : ' class="major"') + ' x1="' + (60 + r1 * Math.sin(a)).toFixed(2) + '" y1="' + (60 - r1 * Math.cos(a)).toFixed(2) + '" x2="' + (60 + r2 * Math.sin(a)).toFixed(2) + '" y2="' + (60 - r2 * Math.cos(a)).toFixed(2) + '"/>'; }).join('');
  if (NATIVE) $('testsLink').href = TESTS_URL;
  $('wcId').value = store.get('wcid');
  const p0 = PLAN(); $('cPay').value = p0.pay || ''; $('cFreq').value = p0.freq; $('cNext').value = p0.next; $('cMode').value = p0.mode; $('cPct').value = p0.pct; $('cFixed').value = p0.fixed || '';
  if (!p0.next) { const d = new Date(); d.setDate(d.getDate() + 1); $('cNext').value = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
  renderLessons(); codeFingerprints(); applyType();
  show(TABS.includes(store.get('tab')) ? store.get('tab') : 'home');
  setAccount('');
  setTimeout(() => initWc(false).catch(() => {}), 400); // paint first, then reconnect the wallet
  if (LN && store.get('notify') === '1') scheduleNotifications(false);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
