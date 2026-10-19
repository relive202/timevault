# TimeVault

**[العربية](README.ar.md)** · English

A phone app that locks your USDC or USDT on Arbitrum One until you reach a savings goal, or until a backup date, whichever comes first. Nobody can take the money out early, including you. When it unlocks, it can only pay your own wallet.

It also has a savings coach: a payday plan, a streak counter, calendar reminders and short money lessons.

There is no server, no account and no company holding your coins. The app is a single web page that talks directly to the Arbitrum blockchain and to your wallet. It works with any wallet app that supports WalletConnect, such as MetaMask, Trust Wallet, Tangem, Rainbow or Coinbase Wallet.

## بالعربية

<div dir="rtl">

**TimeVault** يقفل دولاراتك الرقمية (USDC أو USDT) على شبكة Arbitrum One حتى تصل إلى هدفك أو إلى تاريخ احتياطي، أيهما أسبق. لا يستطيع أحد إخراجها مبكرًا، ولا حتى أنت، وعندما يُفتح القفل يعود المال إلى محفظتك فقط. لا خادم ولا حساب ولا شركة تحتفظ بأموالك. التطبيق متوفر بالعربية: من القائمة (⋯) ← اللغة.

نزّل التطبيق من [Releases](https://github.com/relive202/timevault/releases) أو افتحه من [المتصفح](https://relive202.github.io/timevault/). الشرح الكامل بالعربية في [README.ar.md](README.ar.md).

</div>

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The app. |
| `tests.html` | 49 safety tests you can run on your phone. They use a private simulated blockchain and fake coins. |
| `FINGERPRINTS.txt` | The fingerprints the app and tests must show. |
| `manifest.webmanifest`, `icon-*.png` | Lets you add the app to your home screen. |
| `source/` | Contract source code, the app source, and `build.py`, which rebuilds `index.html` and `tests.html` byte for byte. |
| `android/`, `.github/workflows/android.yml` | The Android app wrapper and the GitHub build that turns it into an APK. |

## The two lock contracts

**Fixed date** uses OpenZeppelin `TokenTimelock` (Contracts 4.9.6), unmodified.

**Savings goal** uses `GoalTimelock`, which is the same OpenZeppelin code with two changes, marked `CHANGE` in `source/GoalTimelock.sol`:

- It stores a goal amount.
- `release()` works when `balance >= goal` **or** the backup date has passed.

Both contracts have:

- No owner and no admin.
- No upgrade path.
- No way to change the beneficiary, date or goal after creation.

`release()` always sends the whole balance to the beneficiary, and only the beneficiary. Anyone may press it, but the money still only goes to the beneficiary.

Compiler settings: solc 0.8.24, optimizer on (200 runs), EVM version paris.

| Contract | keccak256 of creation code |
|---|---|
| GoalTimelock | `0x9ea0a457432e78e589fdb1dffa3bd2c2e67b2fec599fb539b9de8b81b27e9bca` |
| TokenTimelock | `0x29b075c113591090dc177f4c04c75fa4d97f33dcb4b479e05fc78c7138b43d07` |

## Safety measures in the app

1. **One guarded door.** Every transaction goes through `TV.makeGuard` in the safety core. It can do only three things:
   - **Create** a lock that pays the connected wallet.
   - **Deposit** into one of your own verified locks.
   - **Release** a lock.

   The guard builds the transaction bytes itself. Nothing else in the app can ask your wallet to sign.
2. **Exact-code verification.** Before any deposit or release, the app does the following:
   - Reads the lock's settings and rebuilds the exact bytecode a genuine lock with those settings must have.
   - Compares it byte for byte against the chain on several independent servers. Look-alike contracts are refused, even if they claim to pay you.
3. **Multiple servers must agree.** Every server that answers must agree, and at least 2 must answer: 3 for the live check on the Safety tab. A single lying or broken server causes a refusal, never a send.
4. **Dry run first.** Each transaction is simulated before your wallet is asked. If it would fail, you are never asked to sign it.
5. **Confirm screen.** Before Tangem opens, the app shows exactly which address will receive the transaction, so you can check it against what Tangem shows.
6. **Refusals.** The guard stops a transaction when:
   - the network or account is wrong
   - the coin is unsupported
   - the amount is more than you have
   - the lock's date has passed
   - the goal is zero
   - the date is less than an hour or more than 10 years away
   - the standard deployer has been tampered with
   - the fee is too high
7. **Self check at start-up.** Contract bytecode is checked against the fingerprints above. If anything differs, money actions are blocked.
8. **Locked-down page.** All of the following are set in the page:
   - A strict Content Security Policy: scripts run only if they match exact hashes.
   - Network access only to the 4 Arbitrum servers and WalletConnect.
   - Libraries pinned to exact versions with Subresource Integrity, so a changed library file will not load.
9. **No secrets.** The app never sees your private keys. Your WalletConnect Project ID and lock list are stored only on your phone.

## How to check it yourself

- **Safety tab:** all self checks show ✓. The two fingerprints shown match `FINGERPRINTS.txt`. "Run check" verifies every lock on 4 servers.
- **Run `tests.html`:** it should say **49 of 49 tests passed**. The tests cover:
  - Both contracts, early-release attempts and strangers pressing release.
  - Backup dates and USDT-style tokens.
  - 560 random actions checked against a model.
  - 20 attacks on the guard: fake locks, a lying server, a tampered deployer, the wrong network, a changed account, and Cancel.
- **Arbiscan:** the "Goal lock file" and "Fixed-date lock file" downloads on the Safety tab are the exact Standard-JSON inputs. Use them to publish the source on Arbiscan.
- **Rebuild:** run `python3 source/web/build.py`. It must produce `index.html` and `tests.html` identical to the ones here.

## Risks this does not remove

These are honest limits, not bugs:

- **Locked means locked.** If you need the money in an emergency, you cannot get it before the goal or the backup date. Keep an emergency fund outside the lock.
- **Coin issuers.** Circle (USDC) and Tether (USDT) can freeze any address, including a lock. This is rare, but it is outside this code's control.
- **Your wallet.** Losing your Tangem card and backups, or signing something malicious elsewhere, is outside this app.
- **Your copy of the app.** Always open the app from your own home-screen icon or your own GitHub Pages address, never from a link someone sends you. Check the fingerprints on the Safety tab after any update.
- **No professional audit.** The goal contract is a small change to audited OpenZeppelin code and is heavily tested, but it has not been audited by a firm. Start with small amounts.

## Android app

The Android app is the same page with the same safety core, packaged as a real app with [Capacitor](https://capacitorjs.com) 7.0.0. The differences:

- The three libraries are bundled inside the app instead of loaded from the internet. The build downloads each one and stops if its fingerprint differs from the pinned value.
- Scripts may only come from inside the app (`'self'`) and the exact inline-script hashes.
- Payday notifications use the phone's own notification system. The next 26 paydays are scheduled at 9:00 and reset whenever the plan changes.

GitHub builds it: `.github/workflows/android.yml` runs on every change to `source/` or `android/` and publishes a signed `TimeVault.apk` under **Releases**. The release notes list the APK's sha256, its signing certificate and the code fingerprints.

The signing key is kept in two repository secrets, `KEYSTORE_B64` and `KEYSTORE_PASS`, and never in the repository. Every update must be signed with the same key, or Android refuses to install it over the old version.

## License

MIT. See `LICENSE`. Use at your own risk.
