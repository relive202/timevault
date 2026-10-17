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
    document.querySelectorAll('[data-connect]').forEach((b) => { b.textContent = account ? 'Disconnect' : 'Connect wallet'; b.className = account ? 'btn ghost small' : b.dataset.cls; });
    $('welcome').hidden = !!viewer(); $('homeMain').hidden = !viewer(); $('copyMine').hidden = !account;
    p.hidden = !(store.get('watch') && !account) && !(account && chainId !== CHAIN_ID); $('connectBtn').hidden = !!account;
    if (!account) { p.textContent = store.get('watch') ? 'View only' : 'Not connected'; p.className = 'pill'; $('connectBtn').textContent = 'Connect wallet'; }
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
    if (!projectId) { if (connectNow) { go('setup'); document.querySelector('details.advanced').open = true; $('wcId').focus(); toast('This copy of TimeVault needs a WalletConnect Project ID. Add one under Advanced.', 8000); } return; }
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
      try { await wc.connect(); eip = wc; $('qrBox').hidden = true; setAccount(wc.accounts[0], wc.chainId); toast('Wallet connected.'); go('home'); }
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
  const TABS = ['home', 'new', 'coach', 'setup', 'safety', 'menu', 'lock', 'badges'];
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => go(b.dataset.tab)));
  let page = 'home', depth = 0;
  function show(t) {
    TABS.forEach((x) => { $('tab-' + x).hidden = x !== t; });
    page = t; document.body.dataset.page = t; window.scrollTo(0, 0); onScroll();
    if (t === 'badges') renderBadges();
  }
  // every screen is a history step, so the phone's back gesture and the back arrow both go back one screen
  function go(t) {
    if (t === 'home') { if (depth > 0) window.history.go(-depth); else show('home'); return; }
    if (t === page) return;
    depth += 1; window.history.pushState({ tv: t, d: depth }, ''); show(t);
  }
  window.addEventListener('popstate', (e) => { const st = e.state || {}; depth = st.d || 0; show(st.tv || 'home'); });
  $('backBtn').addEventListener('click', () => { if (depth > 0) window.history.back(); else show('home'); });
  // the top bar gets a background and shows the total once the big number scrolls away
  function onScroll() { document.body.classList.toggle('scrolled', window.scrollY > 8); document.body.classList.toggle('pastHero', page === 'home' && window.scrollY > 150); }
  window.addEventListener('scroll', onScroll, { passive: true });
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
    $('menuWallet').textContent = viewer() ? short(viewer()) + (account ? '' : ' (view only)') : 'Not connected';
    $('gasHint').hidden = !(WALLET.ETH !== undefined && WALLET.ETH < ethers.parseEther('0.0002'));
    for (const o of $('lkToken').options) o.textContent = o.value + (WALLET[o.value] !== undefined ? ' (you have ' + num(fmt(WALLET[o.value])) + ')' : '');
    renderLocks(); renderToday(); renderCoach(); updateSummary(); checkMilestones(); renderFun();
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
  $('cheerOk').addEventListener('click', () => { $('cheer').hidden = true; checkMilestones(); checkBadges(); });

  let countFrom = null, countRaf = 0;
  const moneyHTML = (v) => { const m = money(v), i = m.lastIndexOf('.'); return m.slice(0, i) + '<span class="cents">' + m.slice(i) + '</span>'; };
  function countTo(el, v) { // the total glides to its new value instead of jumping
    $('miniTotal').textContent = money(v);
    const reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (countFrom === null || reduce || countFrom === v) { countFrom = v; el.innerHTML = moneyHTML(v); return; }
    const a = countFrom, t0 = performance.now(), dur = 700; countFrom = v; cancelAnimationFrame(countRaf);
    const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.innerHTML = moneyHTML(a + (v - a) * e); if (k < 1) countRaf = requestAnimationFrame(step); };
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

  // each lock gets its own colour pair, picked from its address so it stays the same everywhere
  const POT_COLORS = [['#7C5CFF', '#4F8BFF'], ['#FF6FA8', '#FF9F6B'], ['#1FC7B6', '#52E08F'], ['#FFB547', '#FF7A59'], ['#4F8BFF', '#22C7E8'], ['#B467FF', '#FF6FCF']];
  const ICON_GOAL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r=".8" fill="currentColor"/></svg>';
  const ICON_DATE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>';
  const CHART_HTML = (id) => '<div class="group pad chart" id="' + id + '"><div class="ch-top"><div><span class="ch-label"></span><b class="ch-val"></b></div><div class="ranges">' + ['1M', '3M', '1Y', 'All'].map((r) => '<button data-range="' + r + '">' + r + '</button>').join('') + '</div></div><div class="ch-plot"></div><div class="ch-axis"></div></div>';
  let viewAddr = ''; // the lock shown on its own screen
  function openLock(a) { viewAddr = a; renderLocks(); go('lock'); }
  const potStyle = (l) => { const [g1, g2] = POT_COLORS[[...l.addr.toLowerCase()].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 9973, 7) % POT_COLORS.length]; return '--g1:' + g1 + ';--g2:' + g2; };
  const lockName = (l) => (l.name ? esc(l.name) : (l.kind === 'goal' ? 'Savings goal' : 'Date lock'));
  function renderLocks() {
    const box = $('locks'); const who = viewer();
    if (!who) { box.innerHTML = '<div class="empty">Connect your wallet to see your savings.</div>'; return; }
    if (!loadedOnce && !LOCKS.length && getList(who).length) { box.innerHTML = '<div class="group"><div class="pot-row skel"></div><div class="pot-row skel"></div></div>'; return; }
    const rej = [...rejected.entries()];
    const now = Date.now() / 1000;
    const finished = LOCKS.filter(isFinished), active = LOCKS.filter((l) => !isFinished(l));
    let html = '';
    if (!LOCKS.length) html = '<div class="empty"><b>No locks yet.</b><br>Tap <b>New lock</b> above to start saving.</div>';
    else if (!active.length) html = '<div class="empty"><b>No active locks.</b><br>Tap <b>New lock</b> above to start your next goal.</div>';
    else html = '<div class="group">' + active.map((l) => {
      const s = lockState(l), g = l.kind === 'goal';
      return '<button class="pot-row" data-open="' + l.addr + '" style="' + potStyle(l) + '"><span class="pot-ico" aria-hidden="true">' + (g ? ICON_GOAL : ICON_DATE) + '</span>' +
        '<span class="pot-mid"><b>' + lockName(l) + '</b><span class="' + s.cls + '">' + s.label + '</span></span>' +
        '<span class="pot-end"><b>' + money(fmt(l.balance)) + '</b><span>' + (g ? 'of ' + money(fmt(l.goal)).replace(/\.00$/, '') : l.sym) + '</span></span></button>';
    }).join('') + '</div>';
    if (finished.length) html += '<details class="rejected"><summary>Finished (' + finished.length + ')</summary>' + finished.map((l) => '<div class="small">' + esc(l.name || (l.kind === 'goal' ? num(fmt(l.goal)) + ' ' + l.sym + ' goal' : l.sym + ' lock')) + ': ' + (now >= l.releaseTime ? 'ended ' + dateStr(l.releaseTime) : 'withdrawn') + ', nothing left inside. <a href="https://arbiscan.io/address/' + l.addr + '" target="_blank" rel="noopener noreferrer">View</a> · <a href="#" data-hide="' + l.addr + '">Hide</a></div>').join('') + '</details>';
    if (rej.length) html += '<details class="rejected"><summary>' + rej.length + ' address' + (rej.length > 1 ? 'es' : '') + ' hidden: not a genuine TimeVault lock for this wallet</summary>' + rej.map(([a, why]) => '<div class="small"><span class="mono">' + esc(a) + '</span><br>' + esc(why) + '</div>').join('') + '</details>';
    const finOpen = !!box.querySelector('details.rejected[open]');
    box.innerHTML = html;
    if (finOpen) { const d = box.querySelector('details.rejected'); if (d) d.open = true; }
    box.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openLock(b.dataset.open)));
    bindHide(box);
    renderLockView();
  }
  function bindHide(root) {
    root.querySelectorAll('[data-hide]').forEach((b) => b.addEventListener('click', (ev) => {
      ev.preventDefault(); const w = viewer(); if (!w) return;
      const lst = store.json(hiddenKey(w), []); lst.push(b.dataset.hide.toLowerCase()); store.setJson(hiddenKey(w), [...new Set(lst)]);
      toast('Hidden. You can show it again in Settings.'); if (page === 'lock') go('home'); refresh();
    }));
  }
  const ACT_ADD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M6 13l6 6 6-6"/></svg>';
  const ACT_EX = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h13l-4-4M20 14H7l4 4"/></svg>';
  const ACT_OUT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  const ACT_COPY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8.5" y="8.5" width="11" height="11" rx="2.5"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2"/></svg>';
  function renderLockView() {
    const v = $('lockView'); const l = LOCKS.find((x) => x.addr === viewAddr);
    if (!l) { v.innerHTML = '<div class="empty">This lock is no longer in your list.</div>'; return; }
    const detOpen = !!v.querySelector('details[open]');
    const s = lockState(l), g = l.kind === 'goal', now = Date.now() / 1000;
    const pct = g ? Math.min(100, 100 * fmt(l.balance) / fmt(l.goal)) : Math.min(100, Math.max(0, l.created ? (now - l.created) / (l.releaseTime - l.created) * 100 : (s.timeUp ? 100 : 0)));
    const mine = account && account === l.beneficiary;
    const row = (k, val) => '<div class="irow"><span>' + k + '</span><b>' + val + '</b></div>';
    v.setAttribute('style', potStyle(l));
    v.innerHTML =
      '<div class="lv-head"><span class="pot-ico" aria-hidden="true">' + (g ? ICON_GOAL : ICON_DATE) + '</span><h1>' + lockName(l) + '</h1>' +
        '<div class="big">' + moneyHTML(fmt(l.balance)) + '</div><span class="label">' + (g ? 'of ' + money(fmt(l.goal)).replace(/\.00$/, '') + ' ' + l.sym + ' goal' : l.sym + ' locked until ' + dateStr(l.releaseTime)) + '</span></div>' +
      (fxLine(fmt(l.balance)) ? '<span class="chip">' + fxLine(fmt(l.balance)) + '</span>' : '') +
      '<div class="quick" id="lvActs"></div>' +
      CHART_HTML('lockChart') +
      (g && s.timeUp && !s.empty ? '<p class="note">The backup date has passed, so this money is free. Withdraw it and start a new goal.</p>' : '') + (g && s.goalHit && !s.empty && !s.timeUp ? '<p class="note">You did it! Withdraw your savings whenever you like.</p>' : '') +
      (s.empty && s.timeUp ? '' : '<div class="group pad"><div class="prog-top"><b class="' + s.cls + '">' + s.label + '</b><span>' + (g ? (s.goalHit ? 'Goal reached' : num(Math.max(0, fmt(l.goal) - fmt(l.balance))) + ' ' + l.sym + ' to go') : (s.timeUp ? 'Unlocked' : untilStr(l.releaseTime) + ' left')) + '</span></div><div class="bar" role="progressbar" aria-valuenow="' + pct.toFixed(0) + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>') +
      '<div class="group">' +
        (g ? row('Opens at', num(fmt(l.goal)) + ' ' + l.sym) + row('Backup date', dateStr(l.releaseTime)) : row('Opens on', dateStr(l.releaseTime))) +
        row('Pays out to', '<span class="mono">' + short(l.beneficiary) + '</span>' + (mine ? ' (you)' : '')) +
        row('Coin', l.sym + ' on Arbitrum One') +
        row('Safety check', '<span class="ok-text">✓ Genuine lock</span>') +
      '</div>' +
      '<details class="group pad"><summary>Lock address and details</summary><p class="small caution">Only ever send ' + l.sym + ' on the Arbitrum One network to this address, using Add money. Any other coin or network sent here is lost forever.</p><div class="mono small">Lock ' + l.addr + '<br>Coin ' + l.token + '<br>Pays to ' + l.beneficiary + '<br>Contract ' + (g ? 'GoalTimelock' : 'TokenTimelock (OpenZeppelin)') + '<br><a href="https://arbiscan.io/address/' + l.addr + '" target="_blank" rel="noopener noreferrer">Open on Arbiscan</a></div>' + (l.balance === 0n ? '<button class="btn ghost small" data-hide="' + l.addr + '" style="margin-top:10px">Hide this lock</button>' : '') + '</details>';
    if (detOpen) v.querySelector('details').open = true;
    const acts = $('lvActs');
    const act = (icon, label, fn) => { const b = document.createElement('button'); b.innerHTML = '<span class="qi">' + icon + '</span><span class="lbl">' + label + '</span>'; b.onclick = () => fn(b); acts.appendChild(b); };
    if (mine && !s.timeUp) act(ACT_ADD, 'Add money', () => openDeposit(l));
    if (mine && !s.timeUp) act(ACT_EX, 'From exchange', () => { openDeposit(l); depTab(true); });
    if (mine && s.ready) act(ACT_OUT, 'Withdraw', (b) => run(b, async () => { await ensureArbitrum(); await guard.release({ lock: l.addr }); toast('Done! The money is back in your wallet.'); }));
    act(ACT_COPY, 'Copy address', async () => { try { await navigator.clipboard.writeText(l.addr); toast('Lock address copied. Only send ' + l.sym + ' on Arbitrum One to it.', 7000); } catch { toast('Open "Lock address and details" to copy it.'); } });
    acts.style.gridTemplateColumns = 'repeat(' + acts.children.length + ', 1fr)';
    bindHide(v);
    v.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { store.set('range', b.dataset.range); renderCharts(); }));
    renderCharts();
  }


  async function run(btn, fn) {
    const lbl = btn.querySelector('.lbl') || btn; const t = lbl.textContent; btn.disabled = true; lbl.textContent = 'Working…';
    const stopped = new Promise((_, rej) => { stopWait = () => rej(new TV.Refused('Stopped waiting. If you still approve it in your wallet, it can go through, so check your savings before trying again.')); });
    try { await Promise.race([fn(), stopped]); } catch (e) { toast(nice(e), 10000); } finally { stopWait = null; waiting(false); btn.disabled = false; lbl.textContent = t; historyAt = 0; lastSig = ''; refresh(); }
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
      go('home');
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
  $('quickAdd').addEventListener('click', () => { // add money: straight to the lock if there is only one you can add to
    if (!account) return toast('Connect your wallet first.');
    const mine = LOCKS.filter((l) => l.beneficiary === account && !isFinished(l) && Date.now() / 1000 < l.releaseTime);
    if (mine.length === 1) return openDeposit(mine[0]);
    if (!mine.length) { go('new'); return toast('Make a lock first, then add money to it.'); }
    $('locks').scrollIntoView({ behavior: 'smooth', block: 'start' }); toast('Pick which savings to add money to.');
  });
  function bindGo(root) { root.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => go(b.dataset.go))); }
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
    if (fromCacheOnly || !history) { history = buildHistory(who); renderHistory(); renderToday(); renderFun(); }
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
    renderHistory(); renderToday(); if (history.length !== before) renderLocks(); renderFun();
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

  // ------------------------------------------------------------------ savings over time (display only, built from deposit history)
  // A lock's value at time t = its balance now minus everything deposited after t (never below zero).
  const valueAt = (locks, t) => locks.reduce((s, l) => {
    const after = (history || []).filter((h) => h.to === l.addr && h.time > t).reduce((a, h) => a + fmt(h.amount), 0);
    return s + Math.max(0, fmt(l.balance) - after);
  }, 0);
  const RANGES = { '1M': 30, '3M': 91, '1Y': 365, All: 0 };
  const shortDate = (t) => new Date(t * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  function drawChart(box, locks, range) {
    if (!box) return;
    if (!locks.length || !history) { box.hidden = !locks.length; if (locks.length) box.querySelector('.ch-plot').innerHTML = '<p class="ch-empty">Loading your history…</p>'; return; }
    box.hidden = false;
    const now = Math.floor(Date.now() / 1000), addrs = new Set(locks.map((l) => l.addr));
    const deps = history.filter((h) => addrs.has(h.to) && h.time).map((h) => h.time).sort((a, b) => a - b);
    const first = Math.min(deps[0] || now, ...locks.map((l) => l.created || now));
    const begin = Math.min(first - DAY, now - DAY), start = RANGES[range] ? Math.max(now - RANGES[range] * DAY, begin) : begin; // start a day before the first deposit, so the line rises from zero
    const pts = [[start, valueAt(locks, start)]];
    for (const t of deps) if (t > start) { pts.push([t - 1, valueAt(locks, t - 1)], [t, valueAt(locks, t)]); }
    pts.push([now, valueAt(locks, now)]);
    const v0 = pts[0][1], v1 = pts[pts.length - 1][1], max = Math.max(1, ...pts.map((p) => p[1])) * 1.12;
    const X = (t) => (t - start) / Math.max(1, now - start) * 300, Y = (v) => 100 - v / max * 100;
    const line = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(2) + ' ' + Y(p[1]).toFixed(2)).join(' ');
    const label = { '1M': 'Last month', '3M': 'Last 3 months', '1Y': 'Last year', All: 'Since you started' }[range];
    const d = v1 - v0, p = v0 > 0 ? Math.round(d / v0 * 100) : null, pct = p !== null && Math.abs(p) <= 999 ? ' <span class="pct">' + (p >= 0 ? '+' : '') + p + '%</span>' : '';
    const head = () => { box.querySelector('.ch-label').textContent = label; box.querySelector('.ch-val').innerHTML = (d >= 0 ? '+' : '\u2212') + money(Math.abs(d)) + pct; };
    box.querySelector('.ch-plot').innerHTML =
      '<svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="cg' + box.id + '" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:var(--c1);stop-opacity:.3"/><stop offset="1" style="stop-color:var(--c1);stop-opacity:0"/></linearGradient></defs>' +
      '<path d="' + line + ' L300 100 L0 100 Z" fill="url(#cg' + box.id + ')"/><path d="' + line + '" fill="none" style="stroke:var(--c1)" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>' +
      '<i class="ch-x" hidden></i><i class="ch-dot" style="left:100%;top:' + Y(v1) + '%"></i>';
    box.querySelector('.ch-axis').innerHTML = '<span>' + shortDate(start) + '</span><span>Today</span>';
    box.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
    head();
    const plot = box.querySelector('.ch-plot'), xl = plot.querySelector('.ch-x'), dot = plot.querySelector('.ch-dot');
    const at = (ev) => { // scrub: the header shows the date and amount under your finger
      const r = plot.getBoundingClientRect(), f = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), t = start + f * (now - start);
      const v = valueAt(locks, t);
      xl.hidden = false; xl.style.left = (f * 100) + '%'; dot.style.left = (f * 100) + '%'; dot.style.top = Y(v) + '%';
      box.querySelector('.ch-label').textContent = f > 0.995 ? 'Today' : shortDate(t); box.querySelector('.ch-val').textContent = money(v);
    };
    plot.onpointermove = plot.onpointerdown = at;
    plot.onpointerleave = plot.onpointercancel = plot.onpointerup = () => { xl.hidden = true; dot.style.left = '100%'; dot.style.top = Y(v1) + '%'; head(); };
  }
  const chartRange = () => (RANGES[store.get('range')] !== undefined ? store.get('range') : '3M');
  document.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => { store.set('range', b.dataset.range); renderCharts(); }));
  function renderCharts() {
    drawChart($('homeChart'), viewer() ? LOCKS.filter((l) => l.balance > 0n) : [], chartRange());
    const l = LOCKS.find((x) => x.addr === viewAddr);
    if (l && $('lockChart')) drawChart($('lockChart'), l.balance > 0n ? [l] : [], chartRange());
  }
  function monthLine() { // "+$180 locked this month"
    const el = $('monthLine'); if (!el) return;
    if (!viewer() || !history) { el.hidden = true; return; }
    const m = new Date(); m.setDate(1); m.setHours(0, 0, 0, 0);
    const sum = history.filter((h) => h.time * 1000 >= m.getTime()).reduce((s, h) => s + fmt(h.amount), 0);
    el.hidden = false; el.className = 'chip' + (sum > 0 ? ' up' : '');
    el.textContent = sum > 0 ? '+' + money(sum) + ' this month' : 'Nothing locked yet this month';
  }

  // ------------------------------------------------------------------ your own currency (rate typed in by you, nothing fetched)
  const FX = () => store.json('fx', null);
  function fxLine(usd) {
    const f = FX(); if (!f || !(f.rate > 0)) return '';
    const v = Math.floor(usd * f.rate);
    return '≈ ' + v.toLocaleString() + ' ' + f.code;
  }
  function renderFx() {
    const total = LOCKS.reduce((s, l) => s + fmt(l.balance), 0), f = FX();
    const el = $('fxLine'); const t = viewer() ? fxLine(total) : '';
    el.hidden = !t; el.textContent = t;
    if (f) { $('fxCode').value = f.code; $('fxRate').value = f.rate; $('fxNote').textContent = 'Rate saved ' + dateStr(f.at) + '. Update it whenever the rate moves.'; }
  }
  $('fxSave').addEventListener('click', () => {
    const code = $('fxCode').value, rate = Number(String($('fxRate').value).replace(/,/g, ''));
    if (!(rate > 0) || rate > 1e7) { store.set('fx', ''); renderFx(); return toast('Cleared. Type a rate like 7.5 to show your savings in ' + code + '.'); }
    store.setJson('fx', { code, rate, at: Math.floor(Date.now() / 1000) }); renderFx(); toast('Saved. Your savings now also show in ' + code + '.');
  });
  $('fxLine').addEventListener('click', () => go('setup'));

  // ------------------------------------------------------------------ levels and badges (just for fun: they never touch your money)
  const LEVELS = [['New saver', 0, '#6E6E78', '#8E8E96'], ['Bronze', 100, '#B0703C', '#E0A26A'], ['Silver', 500, '#8C96A8', '#D6DCE6'], ['Gold', 1000, '#C9971C', '#FFD66B'],
    ['Platinum', 2500, '#5FB3C4', '#C6F1F7'], ['Diamond', 5000, '#4F8BFF', '#B79BFF'], ['Legend', 10000, '#FF6FA8', '#FFB547']];
  const levelOf = (usd) => { let i = 0; LEVELS.forEach((x, k) => { if (usd >= x[1]) i = k; }); return i; };
  const BI = (p) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  const B_ICONS = {
    lock: BI('<rect x="5" y="10.5" width="14" height="10" rx="3"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5"/>'), plus: BI('<path d="M12 5v14M5 12h14"/>'),
    target: BI('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/>'), layers: BI('<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>'),
    flame: BI('<path d="M12 21c4 0 6.5-2.6 6.5-6.2 0-3.6-2.6-5.6-4-8.8-1.5 2-2 3.4-2.3 5-1.2-1-1.7-2.3-1.9-3.6C8 9.4 5.5 11.7 5.5 14.8 5.5 18.4 8 21 12 21z"/>'),
    clock: BI('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'), cal: BI('<rect x="4" y="5.5" width="16" height="14.5" rx="3"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/>'),
    swap: BI('<path d="M4 10h13l-4-4M20 14H7l4 4"/>'), star: BI('<path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.6L12 16.7l-5.1 2.7 1-5.6-4.1-4 5.7-.8z"/>'),
    medal: BI('<circle cx="12" cy="14.5" r="5.5"/><path d="M8.5 9.8L6 3.5h4l2 4 2-4h4l-2.5 6.3"/>'),
  };
  const BADGES = [
    ['first-lock', 'First lock', 'Make your first lock.', 'lock', '#7C5CFF', '#4F8BFF', (c) => c.locks >= 1],
    ['first-dep', 'First deposit', 'Put money into a lock.', 'plus', '#1FC7B6', '#52E08F', (c) => c.deps >= 1],
    ['big-dep', 'Big move', 'Lock $100 or more in one go.', 'star', '#FFB547', '#FF7A59', (c) => c.biggest >= 100],
    ['three-locks', 'Three goals', 'Have 3 locks saving at once.', 'layers', '#4F8BFF', '#22C7E8', (c) => c.active >= 3],
    ['streak-3', 'On a roll', 'Save 3 paydays in a row.', 'flame', '#FF7A59', '#FFB547', (c) => c.streak >= 3],
    ['streak-6', 'Habit', 'Save 6 paydays in a row.', 'flame', '#FF6FA8', '#FF7A59', (c) => c.streak >= 6],
    ['streak-12', 'Unstoppable', 'Save 12 paydays in a row.', 'flame', '#B467FF', '#FF6FCF', (c) => c.streak >= 12],
    ['months-3', 'Steady', 'Lock money in 3 different months.', 'cal', '#1FC7B6', '#4F8BFF', (c) => c.months >= 3],
    ['patient-90', 'Patient', 'Keep money locked for 90 days.', 'clock', '#5FB3C4', '#4F8BFF', (c) => c.oldestDays >= 90],
    ['patient-365', 'One year strong', 'Keep money locked for a full year.', 'clock', '#B467FF', '#4F8BFF', (c) => c.oldestDays >= 365],
    ['direct', 'Straight in', 'Send money to a lock straight from an exchange.', 'swap', '#22B573', '#45E0A6', (c) => c.external >= 1],
    ['goal-hit', 'Goal reached', 'Reach a savings goal.', 'target', '#22B573', '#45E0A6', (c) => c.goalHit],
  ];
  function badgeCtx() {
    const now = Date.now() / 1000, h = history || [];
    const live = LOCKS.filter((l) => l.balance > 0n), liveAddr = new Set(live.map((l) => l.addr));
    const oldest = h.filter((x) => liveAddr.has(x.to) && x.time).reduce((m, x) => Math.min(m, x.time), now);
    return { locks: LOCKS.length, deps: h.length, biggest: h.reduce((m, x) => Math.max(m, fmt(x.amount)), 0), active: LOCKS.filter((l) => !isFinished(l)).length,
      streak: streak(), months: new Set(h.filter((x) => x.time).map((x) => new Date(x.time * 1000).toISOString().slice(0, 7))).size,
      oldestDays: (now - oldest) / DAY, external: h.filter((x) => !x.fromMe).length, goalHit: LOCKS.some((l) => l.kind === 'goal' && l.balance > 0n && l.balance >= l.goal) };
  }
  const badgeKey = (w) => 'bdg.' + w.toLowerCase();
  function earnedBadges() { // earned badges are remembered, so a badge stays yours after you withdraw
    const w = viewer(); if (!w || !history) return new Set();
    const c = badgeCtx(); const now = BADGES.filter((b) => b[6](c)).map((b) => b[0]);
    const kept = account && w === account ? (store.json(badgeKey(w), null)?.ids || []) : [];
    return new Set([...kept, ...now]);
  }
  function checkBadges() { // celebrate a new badge or level once, the first time you earn it
    if (!account || viewer() !== account || !historyLoaded || !loadedOnce || !$('cheer').hidden) return;
    const st = store.json(badgeKey(account), null); const ids = [...earnedBadges()];
    const total = LOCKS.reduce((s, l) => s + fmt(l.balance), 0), lv = levelOf(total);
    if (!st) { store.setJson(badgeKey(account), { ids, lv }); return; } // first look: no party for old progress
    const fresh = ids.filter((i) => !st.ids.includes(i));
    if (lv > (st.lv || 0)) { store.setJson(badgeKey(account), { ids: st.ids, lv }); return cheer(LEVELS[lv][2], LEVELS[lv][3], B_ICONS.medal, 'You are ' + (lv === 6 ? 'a Legend' : LEVELS[lv][0]) + '!', 'You have ' + money(total) + ' locked. ' + (LEVELS[lv + 1] ? money(LEVELS[lv + 1][1] - total) + ' to ' + LEVELS[lv + 1][0] + '.' : 'That is the top level.')); }
    if (fresh.length) { const b = BADGES.find((x) => x[0] === fresh[0]); store.setJson(badgeKey(account), { ids: [...st.ids, fresh[0]], lv: Math.max(lv, st.lv || 0) }); return cheer(b[4], b[5], B_ICONS[b[3]], 'New badge: ' + b[1], b[2].replace(/\.$/, '') + ': done. See all your badges under Achievements.'); }
  }
  function cheer(c1, c2, icon, title, text) {
    $('cheerPct').innerHTML = '<span class="badge-ico big" style="--g1:' + c1 + ';--g2:' + c2 + '">' + icon + '</span>';
    $('cheerTitle').textContent = title; $('cheerText').textContent = text; $('cheerOk').textContent = 'Nice!'; $('cheer').hidden = false;
  }
  function renderLevel() {
    const w = viewer(); const box = $('levelRow'); if (!box) return;
    if (!w || !loadedOnce) { box.hidden = true; return; }
    const total = LOCKS.reduce((s, l) => s + fmt(l.balance), 0), lv = levelOf(total), nx = LEVELS[lv + 1];
    const pct = nx ? Math.min(100, (total - LEVELS[lv][1]) / (nx[1] - LEVELS[lv][1]) * 100) : 100;
    const n = earnedBadges().size;
    box.hidden = false;
    box.innerHTML = '<span class="badge-ico" style="--g1:' + LEVELS[lv][2] + ';--g2:' + LEVELS[lv][3] + '">' + B_ICONS.medal + '</span><span class="mmid"><b>' + LEVELS[lv][0] + (lv ? ' saver' : '') + '</b><span>' + (nx ? money(nx[1] - total) + ' to ' + nx[0] : 'Top level reached') + ' · ' + n + ' of ' + BADGES.length + ' badges</span><span class="lvbar"><i style="width:' + pct.toFixed(1) + '%;background:linear-gradient(90deg,' + LEVELS[lv][2] + ',' + LEVELS[lv][3] + ')"></i></span></span><svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  }
  function renderBadges() {
    const w = viewer(); const total = LOCKS.reduce((s, l) => s + fmt(l.balance), 0), lv = levelOf(total);
    $('lvList').innerHTML = LEVELS.map((x, k) => '<div class="lv' + (k <= lv && w ? ' got' : '') + '"><span class="badge-ico" style="--g1:' + x[2] + ';--g2:' + x[3] + '">' + B_ICONS.medal + '</span><b>' + x[0] + '</b><span>' + (k ? money(x[1]).replace('.00', '') : 'Start') + '</span></div>').join('');
    const got = earnedBadges();
    $('badgeGrid').innerHTML = BADGES.map((b) => '<div class="bdg' + (got.has(b[0]) ? ' got' : '') + '"><span class="badge-ico" style="--g1:' + b[4] + ';--g2:' + b[5] + '">' + B_ICONS[b[3]] + '</span><b>' + b[1] + '</b><span>' + b[2] + '</span></div>').join('');
    $('badgeCount').textContent = got.size + ' of ' + BADGES.length + ' earned';
  }
  $('levelRow').addEventListener('click', () => go('badges'));
  function renderFun() { renderCharts(); monthLine(); renderFx(); renderLevel(); if (page === 'badges') renderBadges(); checkBadges(); }

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
  window.history.replaceState({ tv: 'home', d: 0 }, ''); show('home');
  setAccount('');
  setTimeout(() => initWc(false).catch(() => {}), 400); // paint first, then reconnect the wallet
  if (LN && store.get('notify') === '1') scheduleNotifications(false);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
