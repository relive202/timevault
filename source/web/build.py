import base64, hashlib, html, json, os, re
D = os.path.dirname(os.path.abspath(__file__)); R = os.path.dirname(D)
rd = lambda p: open(os.path.join(D, p), encoding='utf-8').read()
rr = lambda p: open(os.path.join(R, p), encoding='utf-8').read()
h256 = lambda s: "'sha256-" + base64.b64encode(hashlib.sha256(s.encode('utf-8')).digest()).decode() + "'"

core = rd('core.js').replace("'__TT_BYTECODE__'", "'" + rr('tt_bytecode.txt').strip() + "'").replace("'__GT_BYTECODE__'", "'" + rr('gt_bytecode.txt').strip() + "'")
assert '__TT_BYTECODE__' not in core and '__GT_BYTECODE__' not in core
app = rd('app.js'); tests = rd('tests.js')
_wc = rd('walletconnect_project_id.txt').strip() if os.path.exists(os.path.join(D, 'walletconnect_project_id.txt')) else ''
assert _wc == '' or re.fullmatch(r'[0-9a-f]{32}', _wc), 'walletconnect_project_id.txt must hold a 32-character Project ID'
if _wc: app = app.replace('__WC_PROJECT_ID__', _wc)
oz = json.loads(rd('oz.json'), object_pairs_hook=dict)
goal_src = rr('GoalTimelock.sol')
shim = "window.process = { env: { NODE_ENV: 'production' } };"
sources = 'window.TV_SOURCES = ' + json.dumps({'oz': oz, 'goal': goal_src}, ensure_ascii=False).replace('</', '<\\/') + ';'
runner = rd('runner.js').replace('__MOCK_BYTECODE__', rr('mock_bytecode.txt').strip()).replace('__FAKE_BYTECODE__', rd('fake_bytecode.txt').strip())
for s in (core, app, tests, runner, sources): assert '</script' not in s.lower()

LIBS = ['https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js',
        'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.17.0/dist/index.umd.js',
        'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js']
RPC_HOSTS = 'https://arb1.arbitrum.io https://arbitrum-one-rpc.publicnode.com https://arbitrum.drpc.org https://arbitrum.meowrpc.com'
WC_HOSTS = 'wss://relay.walletconnect.org wss://relay.walletconnect.com https://*.walletconnect.org https://*.walletconnect.com https://*.reown.com https://*.web3modal.org https://*.web3modal.com'
app_csp = ("default-src 'none'; script-src " + ' '.join(h256(x) for x in (shim, sources, core, app)) + ' ' + ' '.join(LIBS) +
           "; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src " + RPC_HOSTS + ' ' + WC_HOSTS +
           "; manifest-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'")
index = rd('index.template.html')
for k, v in {'{{CSP}}': app_csp, '{{SHIM}}': shim, '{{SOURCES}}': sources, '{{CORE}}': core, '{{APP}}': app,
             '{{GT_SOURCE_HTML}}': html.escape(goal_src), '{{TT_SOURCE_HTML}}': html.escape(oz['@openzeppelin/contracts/token/ERC20/utils/TokenTimelock.sol'])}.items():
    assert k in index, k; index = index.replace(k, v)

test_csp = ("default-src 'none'; script-src " + ' '.join(h256(x) for x in (core, tests, runner)) +
            " https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.umd.min.js https://cdn.jsdelivr.net/npm/ganache@7.9.2/dist/web/ganache.min.js 'wasm-unsafe-eval' 'unsafe-eval'" +
            "; style-src 'unsafe-inline'; connect-src 'none'; worker-src blob:; base-uri 'none'; form-action 'none'; object-src 'none'")
tpage = rd('tests.template.html')
for k, v in {'{{CSP}}': test_csp, '{{CORE}}': core, '{{TESTS}}': tests, '{{RUNNER}}': runner}.items():
    assert k in tpage, k; tpage = tpage.replace(k, v)

out = os.path.join(D, 'dist'); os.makedirs(out, exist_ok=True)
open(os.path.join(out, 'index.html'), 'w', encoding='utf-8').write(index)
open(os.path.join(out, 'tests.html'), 'w', encoding='utf-8').write(tpage)
json.dump({'name': 'TimeVault', 'short_name': 'TimeVault', 'description': 'Lock your savings until you reach your goal.', 'start_url': './', 'scope': './',
           'display': 'standalone', 'background_color': '#0e1311', 'theme_color': '#0e1311',
           'icons': [{'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'}, {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
                     {'src': 'icon-512-maskable.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'}]},
          open(os.path.join(out, 'manifest.webmanifest'), 'w'), indent=2)

# icons
from PIL import Image, ImageDraw
def icon(size, maskable=False):
    s = 4; S = size * s; im = Image.new('RGBA', (S, S), (0, 0, 0, 0)); d = ImageDraw.Draw(im)
    pad = 0 if maskable else int(S * 0.06); r = 0 if maskable else int(S * 0.22)
    d.rounded_rectangle([pad, pad, S - pad, S - pad], radius=r, fill=(148, 101, 25, 255))
    c = S / 2; R = S * (0.25 if maskable else 0.29); w = int(S * 0.065)
    d.ellipse([c - R, c - R, c + R, c + R], outline=(255, 255, 255, 255), width=w)
    k = S * 0.068; d.ellipse([c - k, c - k * 1.6, c + k, c + k * 0.4], fill=(255, 255, 255, 255))
    d.rounded_rectangle([c - k * 0.45, c - k * 0.4, c + k * 0.45, c + k * 1.9], radius=int(k * 0.4), fill=(255, 255, 255, 255))
    return im.resize((size, size), Image.LANCZOS)
for sz in (180, 192, 512): icon(sz).save(os.path.join(out, 'icon-%d.png' % sz))
icon(512, True).save(os.path.join(out, 'icon-512-maskable.png'))

# ---- Android app version: identical page, but libraries are bundled inside the app (no code loaded from the internet)
aout = os.path.join(D, 'dist-android'); os.makedirs(aout, exist_ok=True)
android_csp = app_csp.replace(' '.join(LIBS), "'self'")
assert android_csp != app_csp
aindex = index.replace(app_csp, android_csp).replace('<link rel="manifest" href="manifest.webmanifest">', '')
libs_txt = []
for u in LIBS:
    m = re.search(r'<script src="' + re.escape(u) + r'" integrity="([^"]+)" crossorigin="anonymous"></script>', aindex)
    assert m, u
    local = 'lib/' + {0: 'ethers.umd.min.js', 1: 'walletconnect-provider.umd.js', 2: 'qrcode.min.js'}[LIBS.index(u)]
    aindex = aindex.replace('src="' + u + '"', 'src="' + local + '"')
    libs_txt.append(' '.join((u, local, m.group(1))))
assert 'cdn.jsdelivr' not in aindex and 'cdnjs' not in aindex
open(os.path.join(aout, 'index.html'), 'w', encoding='utf-8').write(aindex)
open(os.path.join(aout, 'libs.txt'), 'w').write('\n'.join(libs_txt) + '\n')

fp = lambda s: h256(s).strip("'")
open(os.path.join(out, 'FINGERPRINTS.txt'), 'w').write(
    'TimeVault build fingerprints\n\nSafety core: %s\nApp screens: %s\nTest page core: %s (must equal Safety core)\n\nGoalTimelock code: 0x9ea0a457432e78e589fdb1dffa3bd2c2e67b2fec599fb539b9de8b81b27e9bca\nTokenTimelock code: 0x29b075c113591090dc177f4c04c75fa4d97f33dcb4b479e05fc78c7138b43d07\n' % (fp(core), fp(app), fp(core)))
print('built', len(index), len(tpage), fp(core), fp(app))
