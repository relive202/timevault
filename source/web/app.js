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

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const fmt = (x) => Number(ethers.formatUnits(x, 6));
  const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const num = (n, d = 2) => Number(n).toLocaleString(undefined, { maximumFractionDigits: d });
  const dateStr = (s) => new Date(Number(s) * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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
    if (!account) { p.textContent = store.get('watch') ? 'Watching ' + short(store.get('watch')) : 'Not connected'; p.className = 'pill'; $('connectBtn').textContent = 'Connect'; }
    else if (chainId !== CHAIN_ID) { p.textContent = short(account) + ' · wrong network'; p.className = 'pill warn'; $('connectBtn').textContent = 'Disconnect'; }
    else { p.textContent = short(account) + ' · Arbitrum'; p.className = 'pill ok'; $('connectBtn').textContent = 'Disconnect'; }
    refresh();
  }
  async function ensureArbitrum() {
    if (!eip) throw new TV.Refused('Connect your wallet first.');
    const c = Number(await eip.request({ method: 'eth_chainId' }));
    if (c === CHAIN_ID) return;
    try { await eip.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] }); chainId = CHAIN_ID; }
    catch { throw new TV.Refused('Switch your wallet to Arbitrum One, then try again.'); }
  }
  async function initWc(connectNow) {
    const projectId = store.get('wcid');
    if (!projectId) { if (connectNow) { show('setup'); $('wcId').focus(); toast('Add your WalletConnect Project ID first (one-time).'); } return; }
    if (!wc) {
      const { EthereumProvider } = window['@walletconnect/ethereum-provider'];
      wc = await EthereumProvider.init({
        projectId, optionalChains: [CHAIN_ID], showQrModal: false, rpcMap: { [CHAIN_ID]: RPCS[0] },
        optionalMethods: ['eth_sendTransaction', 'personal_sign', 'wallet_switchEthereumChain'],
        metadata: { name: 'TimeVault', description: 'Personal savings locks', url: location.origin.startsWith('http') ? location.origin : 'https://timevault.local', icons: [] },
      });
      wc.on('display_uri', (uri) => {
        show('setup'); $('qrBox').hidden = false; $('uriText').textContent = uri; $('copyUri').dataset.uri = uri;
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
  $('connectBtn').addEventListener('click', async () => {
    if (account) { try { if (eip === wc) await wc.disconnect(); } catch {} eip = null; setAccount(''); return; }
    try { await initWc(true); } catch (e) { toast('Could not start WalletConnect: ' + nice(e)); }
  });
  $('wcSave').addEventListener('click', () => { store.set('wcid', $('wcId').value.trim()); wc = null; toast($('wcId').value.trim() ? 'Saved. Now tap Connect.' : 'Cleared.'); });
  $('copyUri').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('copyUri').dataset.uri); toast('Copied. In Tangem: WalletConnect → paste.'); } catch { toast('Select the link text and copy it.'); } });
  $('cancelWc').addEventListener('click', () => { $('qrBox').hidden = true; });
  $('watchSave').addEventListener('click', () => {
    const v = $('watchAddr').value.trim();
    if (v && !ethers.isAddress(v)) return toast('That is not a valid address.');
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
        create: ['Create your lock', 'Tangem will ask you to sign a contract interaction with:', s.to, 'Arbitrum\'s standard contract deployer. No coins move in this step. Fee: a few cents of ETH.'],
        deposit: ['Deposit into your lock', 'Tangem will show a token transfer to:', s.recipient, s.text],
        release: ['Release to your wallet', 'Tangem will ask you to sign a contract interaction with:', s.to, s.text],
      }[s.action];
      $('cfTitle').textContent = lines[0]; $('cfLead').textContent = lines[1];
      $('cfAddr').textContent = lines[2]; $('cfText').textContent = lines[3];
      $('confirm').hidden = false; $('cfGo').focus();
      const done = (v) => { $('confirm').hidden = true; $('cfGo').onclick = $('cfNo').onclick = null; if (v) waiting(true); resolve(v); };
      $('cfGo').onclick = () => done(true); $('cfNo').onclick = () => done(false);
    });
  }
  function waiting(on) { $('waitBar').hidden = !on; }

  // ------------------------------------------------------------------ locks: list, verification, balances
  const listKey = (w) => 'locks.' + w.toLowerCase();
  const getList = (w) => store.json(listKey(w), []);
  const addLock = (w, entry) => { const l = getList(w).filter((x) => x.addr.toLowerCase() !== entry.addr.toLowerCase()); l.push(entry); store.setJson(listKey(w), l); };
  const verified = new Map();   // addr -> verified lock info (this session)
  const rejected = new Map();   // addr -> reason

  async function verifyCached(addr, who) {
    if (verified.has(addr)) return verified.get(addr);
    const L = await TV.verifyLock(ethers, verifyCfg, addr, { beneficiary: who });
    verified.set(addr, L); rejected.delete(addr); return L;
  }

  let LOCKS = []; let WALLET = {};
  async function refresh() {
    const who = viewer();
    renderSelf();
    if (!who) { LOCKS = []; render(); return; }
    try {
      const [eth, ...bals] = await Promise.all([main.getBalance(who), ...Object.values(TOKENS).map((t) => new ethers.Contract(t.address, ERC20, main).balanceOf(who))]);
      WALLET = { ETH: eth, ...Object.fromEntries(Object.keys(TOKENS).map((k, i) => [k, bals[i]])) };
    } catch { WALLET = {}; }
    const list = getList(who);
    const out = [];
    await Promise.all(list.map(async (e) => {
      try {
        const L = await verifyCached(ethers.getAddress(e.addr), who);
        const balance = await new ethers.Contract(L.token, ERC20, main).balanceOf(L.addr);
        out.push({ ...L, balance, created: e.created || 0, block: e.block || 0, name: e.name || '' });
      } catch (err) { if (err.refused) rejected.set(e.addr, err.message); }
    }));
    LOCKS = out.sort((a, b) => (a.kind === b.kind ? a.releaseTime - b.releaseTime : a.kind === 'goal' ? -1 : 1));
    render();
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
    $('totalLocked').textContent = money(total);
    const active = LOCKS.filter((l) => l.balance > 0n || now < l.releaseTime);
    $('lockCount').textContent = String(active.length);
    const goal = LOCKS.find((l) => l.kind === 'goal' && now < l.releaseTime && l.balance < l.goal);
    $('nextMilestone').textContent = goal ? Math.floor(100 * fmt(goal.balance) / fmt(goal.goal)) + '% of ' + money(fmt(goal.goal)) : '—';
    $('walletTotal').textContent = WALLET.USDC !== undefined ? money(fmt(WALLET.USDC) + fmt(WALLET.USDT)) : '—';
    $('walletLine').textContent = WALLET.USDC !== undefined
      ? num(fmt(WALLET.USDC)) + ' USDC · ' + num(fmt(WALLET.USDT)) + ' USDT · ' + Number(ethers.formatEther(WALLET.ETH)).toFixed(5) + ' ETH for fees'
      : (viewer() ? 'Loading balances…' : '');
    $('gasHint').hidden = !(WALLET.ETH !== undefined && WALLET.ETH < ethers.parseEther('0.0002'));
    renderLocks(); renderToday(); renderCoach(); updateSummary();
    const tgt = $('cTarget'); const cur = store.get('plan.target');
    tgt.innerHTML = '<option value="">Choose a goal lock</option>' + LOCKS.filter((l) => l.kind === 'goal').map((l) => '<option value="' + l.addr + '"' + (l.addr === cur ? ' selected' : '') + '>' + esc((l.name ? l.name + ' · ' : '') + num(fmt(l.goal)) + ' ' + l.sym + ' goal · ' + short(l.addr)) + '</option>').join('');
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
    if (!who) { box.innerHTML = '<div class="empty">Connect your wallet to see your savings, or track an address in Setup.</div>'; return; }
    const rej = [...rejected.entries()];
    if (!LOCKS.length) {
      box.innerHTML = '<div class="empty">No locks on this device yet.<br>Make one in <b>New</b>, or tap <b>Find my locks</b> to recover locks you made before.</div>';
    } else box.innerHTML = '';
    const now = Date.now() / 1000;
    for (const l of LOCKS) {
      const s = lockState(l); const g = l.kind === 'goal';
      const pct = g ? Math.min(100, 100 * fmt(l.balance) / fmt(l.goal)) : Math.min(100, Math.max(0, l.created ? (now - l.created) / (l.releaseTime - l.created) * 100 : (s.timeUp ? 100 : 0)));
      const el = document.createElement('article'); el.className = 'lock';
      el.innerHTML =
        '<div class="lock-top"><div><div class="label">' + (g ? 'Savings goal' : 'Fixed date') + (l.name ? ' · ' + esc(l.name) : '') + '</div>' +
        '<div class="lock-amt">' + num(fmt(l.balance)) + (g ? '<span class="of"> / ' + num(fmt(l.goal)) + '</span>' : '') + ' ' + l.sym + '</div></div>' +
        '<span class="state ' + s.cls + '">' + s.label + '</span></div>' +
        (s.empty && s.timeUp ? '' : '<div class="bar' + (g ? ' goalbar' : '') + '" role="progressbar" aria-valuenow="' + pct.toFixed(0) + '" aria-valuemin="0" aria-valuemax="100"><i style="width:' + pct.toFixed(1) + '%"></i></div>') +
        '<div class="kv">' +
          (g ? '<div><span class="label">To go</span>' + (s.goalHit ? 'Done' : num(Math.max(0, fmt(l.goal) - fmt(l.balance))) + ' ' + l.sym) + '</div><div><span class="label">Backup unlock</span>' + dateStr(l.releaseTime) + '</div>'
             : '<div><span class="label">Unlocks</span>' + dateStr(l.releaseTime) + '</div>') +
          '<div><span class="label">Pays to</span><span class="mono">' + short(l.beneficiary) + '</span></div>' +
          '<div><span class="label">Verified</span><span class="ok-text">✓ exact tested code</span></div>' +
        '</div>' +
        (g && s.timeUp && !s.empty ? '<p class="note">The backup date has passed, so this lock no longer holds money back. Release it and start a new goal.</p>' : '') +
        '<details><summary>Details</summary><div class="mono small">Lock ' + l.addr + '<br>Coin ' + l.token + '<br>Pays to ' + l.beneficiary + '<br>Contract ' + (g ? 'GoalTimelock' : 'TokenTimelock (OpenZeppelin)') + '<br><a href="https://arbiscan.io/address/' + l.addr + '" target="_blank" rel="noopener noreferrer">Open on Arbiscan</a></div></details>';
      if (account && account === l.beneficiary) {
        const row = document.createElement('div'); row.className = 'row';
        if (s.ready) {
          const r = document.createElement('button'); r.className = 'btn'; r.textContent = 'Release ' + num(fmt(l.balance)) + ' ' + l.sym + ' to my wallet';
          r.onclick = () => run(r, async () => { await ensureArbitrum(); await guard.release({ lock: l.addr }); toast(g ? 'Goal complete! Sent to your wallet.' : 'Sent to your wallet.'); });
          row.appendChild(r);
        }
        if (!s.timeUp) {
          const d = document.createElement('button'); d.className = g ? 'btn brass' : 'btn ghost'; d.textContent = 'Deposit';
          d.onclick = () => openDeposit(l); row.appendChild(d);
        }
        if (row.children.length) el.appendChild(row);
      }
      box.appendChild(el);
    }
    if (rej.length) {
      const r = document.createElement('details'); r.className = 'rejected';
      r.innerHTML = '<summary>' + rej.length + ' address' + (rej.length > 1 ? 'es' : '') + ' ignored (not genuine locks for this wallet)</summary>' + rej.map(([a, why]) => '<div class="small"><span class="mono">' + esc(a) + '</span><br>' + esc(why) + '</div>').join('');
      box.appendChild(r);
    }
  }

  async function run(btn, fn) {
    const t = btn.textContent; btn.disabled = true; btn.textContent = 'Working…';
    try { await fn(); } catch (e) { toast(nice(e), 9000); } finally { waiting(false); btn.disabled = false; btn.textContent = t; refresh(); }
  }

  // ------------------------------------------------------------------ deposit sheet
  let depLock = null;
  function openDeposit(l, amount) {
    depLock = l; $('depTitle').textContent = 'Deposit into ' + (l.name || (l.kind === 'goal' ? num(fmt(l.goal)) + ' ' + l.sym + ' goal' : 'lock'));
    $('depAmount').value = amount || ''; $('depBal').textContent = WALLET[l.sym] !== undefined ? 'In wallet: ' + num(fmt(WALLET[l.sym]), 6) + ' ' + l.sym : '';
    $('depSheet').hidden = false; $('depAmount').focus();
  }
  $('depClose').addEventListener('click', () => { $('depSheet').hidden = true; });
  $('depMax').addEventListener('click', () => { if (depLock && WALLET[depLock.sym] !== undefined) $('depAmount').value = ethers.formatUnits(WALLET[depLock.sym], 6); });
  $('depGo').addEventListener('click', () => {
    const l = depLock; const raw = $('depAmount').value.trim();
    let amt; try { amt = ethers.parseUnits(raw || '0', 6); } catch { return toast('Enter an amount like 25 or 25.50'); }
    if (amt <= 0n) return toast('Enter an amount.');
    run($('depGo'), async () => {
      await ensureArbitrum();
      const after = await guard.deposit({ lock: l.addr, amount: amt });
      $('depSheet').hidden = true;
      toast(after.kind === 'goal' && after.balance >= after.goal ? 'Goal reached! You can release it now.' : 'Deposited ' + raw + ' ' + l.sym + '.');
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
    $('goalField').hidden = !g; $('amountLabel').textContent = g ? 'First deposit (optional)' : 'Amount';
    $('dateLabel').textContent = g ? 'Backup unlock date' : 'Unlock date'; $('dateHint').hidden = !g;
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
    $('lkBal').textContent = bal !== undefined ? 'In wallet: ' + num(fmt(bal), 6) + ' ' + sym : '';
    const days = ts ? (ts - Date.now() / 1000) / DAY : 0;
    const warn = [];
    if (amt === null) warn.push('Amount: use a number like 25 or 25.50.');
    if (g && goal === null) warn.push('Goal: use a number like 1000.');
    if (!g && amt === 0n) warn.push('Enter an amount.');
    if (g && goal === 0n) warn.push('Pick a goal.');
    if (ts && days < 0.9) warn.push('Pick a date at least a day away.');
    if (days > 3650) warn.push('The date can be at most 10 years away.');
    if (bal !== undefined && amt && amt > bal) warn.push('More than you have in your wallet.');
    if (g && goal && amt && amt >= goal) warn.push('Your first deposit already reaches the goal, so it would unlock right away.');
    if (!account) warn.push('Connect your wallet first.');
    if (!SELF.ok) warn.push('Self check failed. Do not use this copy of the app.');
    const ok = !warn.length && ts && $('lkAgree').checked;
    const goalTxt = goal ? num(fmt(goal)) + ' ' + sym : 'your goal';
    $('lkSummary').innerHTML = [
      g ? '<b>Goal:</b> ' + goalTxt : '<b>Lock:</b> ' + (amt ? num(fmt(amt), 6) : '—') + ' ' + sym,
      g ? '<b>First deposit:</b> ' + (amt ? num(fmt(amt), 6) + ' ' + sym : 'none, add later') : '',
      ts ? (g ? '<b>Unlocks:</b> when it holds ' + goalTxt + ', or on ' + dateStr(ts) + ', whichever comes first' : '<b>Unlocks:</b> ' + dateStr(ts) + ' (' + Math.round(days) + ' days)') : '',
      '<b>Pays to:</b> <span class="mono">' + (account || 'your wallet') + '</span>',
      ...warn.map((w) => '<span class="warn">⚠ ' + esc(w) + '</span>'),
    ].filter(Boolean).map((x) => '<div>' + x + '</div>').join('');
    $('lkAgreeText').textContent = g
      ? 'I understand nobody, including me, can take this money out until the lock holds ' + goalTxt + (ts ? ' or ' + dateStr(ts) + ' arrives' : '') + '.'
      : 'I understand nobody, including me, can take this money out before ' + (ts ? dateStr(ts) : 'the unlock date') + '.';
    $('lkGo').disabled = !ok;
  }
  const step = (n, s) => { $('st' + n).className = s; };
  $('lkGo').addEventListener('click', () => {
    const g = lockType() === 'goal', sym = $('lkToken').value;
    const amt = parse6($('lkAmount').value) || 0n, goal = g ? parse6($('lkGoal').value) : undefined, ts = unlockTs();
    const name = $('lkName').value.trim().slice(0, 40);
    $('lkSteps').hidden = false; [1, 2, 3].forEach((n) => step(n, ''));
    $('st3').textContent = amt > 0n ? 'Send ' + num(fmt(amt), 6) + ' ' + sym + ' into the lock (sign in wallet)' : 'No first deposit. Add money any time with Deposit.';
    run($('lkGo'), async () => {
      await ensureArbitrum();
      const startBlock = await main.getBlockNumber().catch(() => 0);
      step(1, 'doing');
      const L = await guard.create({ kind: g ? 'goal' : 'date', sym, releaseTime: ts, goal, onStep: (s) => { if (s === 'verify') { step(1, 'done'); step(2, 'doing'); waiting(false); } } });
      addLock(account, { addr: L.addr, created: Math.floor(Date.now() / 1000), block: startBlock, name });
      verified.set(L.addr, L); step(2, 'done');
      if (amt > 0n) { step(3, 'doing'); await guard.deposit({ lock: L.addr, amount: amt }); }
      step(3, 'done');
      toast(g ? 'Goal lock created.' : 'Locked until ' + dateStr(ts) + '.', 8000);
      $('lkAmount').value = ''; $('lkAgree').checked = false; $('lkName').value = '';
      if (g && !store.get('plan.target')) store.set('plan.target', L.addr);
      show('home');
    });
  });

  // ------------------------------------------------------------------ find my locks (deposit history from this wallet)
  async function transferLogs(from, toList, windows, progress) {
    const head = await main.getBlockNumber(); const WIN = 9_900_000; const out = [];
    const topic0 = ethers.id('Transfer(address,address,uint256)'), fromT = ethers.zeroPadValue(from, 32);
    const toT = toList ? toList.map((a) => ethers.zeroPadValue(a, 32)) : null;
    for (let w = 0; w < windows; w++) {
      const to = head - w * WIN, fromB = Math.max(0, to - WIN + 1); if (to <= 0) break;
      for (const t of Object.values(TOKENS)) {
        const logs = await main.send('eth_getLogs', [{ address: t.address, topics: toT ? [topic0, fromT, toT] : [topic0, fromT], fromBlock: ethers.toQuantity(fromB), toBlock: ethers.toQuantity(to) }]).catch(() => []);
        out.push(...logs);
      }
      if (progress) $('findBtn').textContent = 'Searching ' + Math.round((w + 1) / windows * 100) + '%…';
    }
    return out;
  }
  $('findBtn').addEventListener('click', async () => {
    const who = viewer(); if (!who) return toast('Connect or track a wallet first.');
    const b = $('findBtn'); b.disabled = true;
    try {
      const logs = await transferLogs(who, null, 28, true);
      const cands = [...new Set(logs.map((l) => ethers.getAddress('0x' + l.topics[2].slice(26))))];
      let found = 0;
      for (const a of cands) {
        if (getList(who).some((e) => e.addr.toLowerCase() === a.toLowerCase())) continue;
        const code = await main.getCode(a).catch(() => '0x');
        if (code.length !== 2 + 1737 * 2 && code.length !== 2 + 1639 * 2) continue;
        try { await verifyCached(a, who); addLock(who, { addr: a }); found++; } catch {}
      }
      toast(found ? 'Found ' + found + ' lock' + (found > 1 ? 's' : '') + '.' : 'No new locks found. (Only locks you deposited into can be found this way. Use Setup → Add a lock by address for others.)', 8000);
      refresh();
    } catch (e) { toast('Search failed: ' + nice(e)); } finally { b.disabled = false; b.textContent = 'Find my locks'; }
  });
  $('addLockBtn').addEventListener('click', async () => {
    const who = viewer(), v = $('addLock').value.trim();
    if (!who) return toast('Connect or track a wallet first.');
    try { const L = await TV.verifyLock(ethers, verifyCfg, v, { beneficiary: who }); verified.set(L.addr, L); addLock(who, { addr: L.addr }); $('addLock').value = ''; toast('Verified and added.'); refresh(); }
    catch (e) { toast(nice(e), 8000); }
  });
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
      if (left === 0) rows.push('<div class="ok-text"><b>Goal reached.</b> Release it, then start your next goal.</div>');
      else {
        const n = Math.ceil(left / S); const { k } = lastAndNext(p); const when = payday(p, k + n);
        rows.push('<div><b>' + money(left) + ' to go:</b> about ' + n + ' more payday' + (n > 1 ? 's' : '') + ', around ' + dayStr(when) + '</div>');
        const backup = new Date(L.releaseTime * 1000); let m = 0; while (payday(p, k + m + 1) < backup && m < 2000) m++;
        if (m > 0 && when > backup) rows.push('<div class="warn">⚠ At this pace you will not reach it before the backup date (' + dateStr(L.releaseTime) + '). To make it, lock about ' + money(Math.ceil(left / m * 100) / 100) + ' each payday.</div>');
      }
    } else rows.push('<div class="muted">Pick a goal lock above to see when you will reach it.</div>');
    out.innerHTML = rows.join('');
  }
  function renderToday() {
    const p = PLAN(); const box = $('today');
    if (!viewer() || !planReady(p)) { box.innerHTML = '<div class="today-empty"><b>Set up your payday plan</b><span>Tell the coach when you get paid and how much to save. It will tell you exactly what to lock each payday.</span><button class="btn ghost small" data-go="coach">Open coach</button></div>'; bindGo(box); return; }
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
  let history = null, historyFor = '';
  async function loadHistory() {
    const who = viewer(); if (!who || !LOCKS.length) { history = []; renderHistory(); return; }
    const key = who + LOCKS.map((l) => l.addr).join();
    if (history && historyFor === key) { renderHistory(); return; }
    historyFor = key;
    try {
      const logs = await transferLogs(who, LOCKS.map((l) => l.addr), 13);
      const blocks = {}; for (const lg of logs) blocks[lg.blockNumber] = 0;
      await Promise.all(Object.keys(blocks).map(async (b) => { const blk = await main.getBlock(Number(b)).catch(() => null); blocks[b] = blk ? blk.timestamp : 0; }));
      history = logs.map((lg) => ({ to: ethers.getAddress('0x' + lg.topics[2].slice(26)), sym: SYMBOL[lg.address.toLowerCase()], amount: BigInt(lg.data), time: blocks[lg.blockNumber], tx: lg.transactionHash }))
        .sort((a, b) => b.time - a.time);
    } catch { history = []; }
    renderHistory(); renderToday();
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
    if (!history) { box.innerHTML = '<p class="muted">Loading your deposits from the blockchain…</p>'; return; }
    if (!history.length) { box.innerHTML = '<p class="muted">No deposits yet. Your first one starts the streak.</p>'; return; }
    const total = history.reduce((s, h) => s + fmt(h.amount), 0);
    $('streakNum').textContent = String(streak());
    box.innerHTML = '<div class="small muted">' + history.length + ' deposits · ' + money(total) + ' saved in the last year</div>' +
      '<ol class="hist">' + history.slice(0, 12).map((h) => '<li><span>' + dateStr(h.time) + '</span><b>+' + num(fmt(h.amount)) + ' ' + h.sym + '</b><a class="mono small" target="_blank" rel="noopener noreferrer" href="https://arbiscan.io/tx/' + h.tx + '">view</a></li>').join('') + '</ol>';
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
    $('selfBanner').hidden = SELF.ok;
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
    if (!who || !LOCKS.length) { box.textContent = 'No locks to check yet.'; return; }
    box.textContent = 'Checking every lock on 4 independent servers…';
    const lines = [];
    for (const l of LOCKS) {
      try { await TV.verifyLock(ethers, { providers, need: 3, tokens: TOKENS }, l.addr, { beneficiary: who }); lines.push('✓ ' + short(l.addr) + ' · exact tested code · pays ' + short(who)); }
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
      const p = PLAN();
      if (!planReady(p)) { notifyNote('Notifications are on. Fill in your plan above and they will be set for each payday.'); return; }
      const { k } = lastAndNext(p); const list = []; const now = Date.now(); const S = money(saveAmount(p));
      for (let i = 0; list.length < 26 && i < 80; i++) {
        const d = payday(p, k + i); d.setHours(9, 0, 0, 0);
        if (d.getTime() > now + 60000) list.push({ id: 1000 + list.length, title: 'Payday: lock ' + S, body: 'Open TimeVault and tap Lock to keep your streak going.', schedule: { at: d, allowWhileIdle: true } });
      }
      if (list.length) await LN.schedule({ notifications: list });
      notifyNote(list.length ? 'Notifications on. Next one: ' + dayStr(list[0].schedule.at) + ' at 9:00.' : '');
    } catch (e) { notifyNote('Could not set notifications: ' + nice(e)); }
  }
  let planT;
  function planChanged() { if (LN && store.get('notify') === '1') { clearTimeout(planT); planT = setTimeout(() => scheduleNotifications(false), 1500); } }
  $('notifyBtn').addEventListener('click', () => scheduleNotifications(true));
  if (LN) { $('icsBtn').hidden = true; $('notifyBtn').hidden = store.get('notify') === '1'; }

  // ------------------------------------------------------------------ boot
  bindGo(document);
  $('wcId').value = store.get('wcid');
  const p0 = PLAN(); $('cPay').value = p0.pay || ''; $('cFreq').value = p0.freq; $('cNext').value = p0.next; $('cMode').value = p0.mode; $('cPct').value = p0.pct; $('cFixed').value = p0.fixed || '';
  if (!p0.next) { const d = new Date(); d.setDate(d.getDate() + 1); $('cNext').value = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-'); }
  renderLessons(); codeFingerprints(); applyType();
  show(TABS.includes(store.get('tab')) ? store.get('tab') : 'home');
  setAccount('');
  initWc(false).catch(() => {});
  if (LN && store.get('notify') === '1') scheduleNotifications(false);
  setInterval(() => { if (!document.hidden) refresh(); }, 60000);
})();
