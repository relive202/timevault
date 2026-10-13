// Test page runner: loads the simulated blockchain (pinned, integrity-checked) and runs every test.
(() => {
  const MOCK = '__MOCK_BYTECODE__', FAKE = '__FAKE_BYTECODE__';
  const GANACHE = { src: 'https://cdn.jsdelivr.net/npm/ganache@7.9.2/dist/web/ganache.min.js', sri: 'sha384-7ZJuPSJycTVhi/25CY7DMzaD94WbBbDu4G0f8YzNRISN1guhFB9NpF8UlXf7ul6Y' };
  const $ = (id) => document.getElementById(id);
  crypto.subtle.digest('SHA-256', new TextEncoder().encode($('coreScript').textContent)).then((h) => { $('fp').textContent = 'sha256-' + btoa(String.fromCharCode(...new Uint8Array(h))); });
  const load = () => new Promise((res, rej) => { if (window.Ganache) return res(); const s = document.createElement('script'); s.src = GANACHE.src; s.integrity = GANACHE.sri; s.crossOrigin = 'anonymous'; s.onload = res; s.onerror = () => rej(new Error('Could not load the test chain (or it failed its integrity check).')); document.head.appendChild(s); });
  $('run').addEventListener('click', async () => {
    const b = $('run'); b.disabled = true; const log = $('log'); log.innerHTML = ''; const sum = $('sum'); sum.className = ''; sum.textContent = 'Loading the test chain (8 MB, first time only)…';
    try {
      await load(); sum.textContent = 'Running…';
      const r = await runTimeVaultTests(ethers, Ganache, MOCK, FAKE, (ok, m) => { const li = document.createElement('li'); li.className = ok ? 'pass' : 'fail'; li.textContent = (ok ? '✓ ' : '✗ ') + m; log.appendChild(li); sum.textContent = 'Running… ' + log.children.length + ' done'; });
      sum.textContent = r.pass + ' of ' + r.total + ' tests passed (' + r.seconds + 's)'; sum.className = r.pass === r.total ? 'ok' : 'bad';
      window.__result = r;
    } catch (e) { sum.textContent = 'Setup failed: ' + (e.message || e); sum.className = 'bad'; window.__result = { err: String(e) }; }
    b.disabled = false;
  });
})();
