# PaySim-BD 🇧🇩

[![Node.js CI](https://github.com/TahmidShafi/PaySim-BD/actions/workflows/ci.yml/badge.svg)](https://github.com/TahmidShafi/PaySim-BD/actions/workflows/ci.yml)
[![Node.js Version](https://img.shields.io/badge/node-22%2B-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%20(strict)-blue.svg)](https://www.typescriptlang.org)
[![Database](https://img.shields.io/badge/SQLite-WAL%20Mode-lightgrey.svg)](https://github.com/WiseLibs/better-sqlite3)
[![Test Suite](https://img.shields.io/badge/tests-73%20passed-success.svg)](https://vitest.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> **High-fidelity local CLI simulator, AWS SNS-style Instant Payment Notification (IPN) webhook dispatcher, deterministic chaos engine, and bKash UAT compliance linter for Bangladesh's bKash Tokenized Checkout.**

Zero external cloud dependencies. Zero floating-point money bugs. 100% reproducible edge cases.

---

## ⚡ 30-Second Quickstart

```bash
# 1. Clone repository & install dependencies
git clone https://github.com/TahmidShafi/PaySim-BD.git
cd PaySim-BD
npm install

# 2. Run the interactive 5-scenario chaos showcase (< 3 seconds)
npm run demo

# 3. Run the full Vitest suite (12 test suites, 73 tests)
npm test

# 4. Measure local system throughput & latency percentiles
npm run benchmark

# 5. Start the local HTTP simulator server and IPN delivery worker
npx paysim start --port 8080
```

---

## 🎯 The 5-Scenario Chaos Matrix

E-commerce merchants in Bangladesh often face financial loss or broken orders because bKash uses a **dual-channel payment flow**: a synchronous frontend browser redirect (`callbackURL?status=success`) alongside an asynchronous, out-of-band AWS SNS webhook (`Notification`).

PaySim-BD includes a **Deterministic Chaos Engine** and both **Naive** and **Hardened** merchant implementations to prove why defensive checkout architectures are mandatory:

| # | Scenario | Injected Chaos Fault | Naive Merchant Result *(Vulnerable)* | Hardened Merchant Result *(Resilient)* |
| :-: | :--- | :--- | :--- | :--- |
| **1** | **Concurrent Duplicate IPN** | `count: 2, intervalMs: 0`<br>*(Simulates network retries / duplicate deliveries)* | ❌ **Double-credits customer wallet** (1,000.00 BDT credited on 500.00 BDT sale) | ✅ **Idempotent single credit** (500.00 BDT) via atomic transaction deduplication |
| **2** | **IPN Arrives Before `/execute` Returns** | `action: 'ipn-before-execute'`<br>*(Holds `/execute` while IPN worker delivers first)* | ❌ **Race condition double-credit** (1,000.00 BDT credited across callback + IPN) | ✅ **Protected 1x credit** (500.00 BDT) via database upsert lock and idempotency keys |
| **3** | **`/execute` Times Out After Commit** | `action: 'timeout-after-commit'`<br>*(Gateway holds connection & returns HTTP 504)* | ❌ **Customer debited, order marked `FAILED`** (Lost revenue, customer dispute) | ✅ **Auto-recovers `trxID` via `/payment/status`** inside timeout catch block (500.00 BDT credited) |
| **4** | **Forged / Tampered SNS Signature** | `action: 'corrupt-signature'`<br>*(Alters payload amount to 99,999.00 BDT)* | ❌ **Accepts spoofed webhook** without cryptographic validation (HTTP 200) | ✅ **Rejects forged signature** using RSA-SHA1 X.509 cert validation (HTTP 400) |
| **5** | **1-Hour `id_token` Expiration** | `clock.advanceMs(3601s)`<br>*(Simulates token expiration past 1h TTL)* | ❌ **Checkout crashes with HTTP 401** (Merchant never refreshes token) | ✅ **Auto-refreshes token via `/token/refresh`** and retries checkout transparently |

Run `npm run demo` to watch all 5 scenarios execute in real time in under 3 seconds!

---

## 🛡️ Built-in bKash UAT Technical Acceptance Linter

bKash rejects merchant applications during User Acceptance Testing (UAT) if they violate mandatory architectural rules from the **bKash Payment Gateway UAT Manual**. PaySim-BD automatically audits incoming merchant requests against verified technical acceptance rules:

| Violation Rule | bKash UAT Citation | Problem & Requirement | Remediation Provided by Linter |
| :--- | :--- | :--- | :--- |
| `UAT_RULE_1_REDUNDANT_TOKEN_GRANT` | **Action Point #0 (Page 4):** *"You must reuse Id_token for 1 hour for any subsequent API request to bKash for any number of payment gateway users."* | Merchant requests a new `id_token` while an active, unexpired token still exists. | Cache `id_token` in memory or Redis and reuse it across all customer sessions. Call `/token/refresh` only when expired. |
| `UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK` | **Action Point #2 & Flow Invariant #2:** *"execute API is called only and only for success status from create payment API callback."* | Merchant calls `/execute` before the user enters OTP/PIN, or calls execute after payment was cancelled or expired. | Never call `/execute` directly after create. Wait for the browser redirect to `callbackURL?status=success` before executing. |
| `UAT_RULE_4_UNNECESSARY_QUERY_STATUS` | **Action Point #4:** *"Query payment should only be called if there is no response from the execute API and inside that block of code. Other than that do not use this API in the API flow of a payment."* | Merchant unconditionally queries `/tokenized/checkout/payment/status` after `/execute` already returned HTTP 200. | Remove status polling from standard checkout. Only query `/payment/status` inside error/timeout catch blocks. |

Audit your integration at any time using the CLI:
```bash
npx paysim lint --db ./paysim.db
```

---

## 🏗️ System Architecture & Invariants

```
                                  +----------------------------------------------+
                                  |                 Client App                   |
                                  |     (Frontend / Mobile / Web Browser)        |
                                  +-----------------------+----------------------+
                                                          |
                               1. create (amount, inv)    | 3. GET callbackURL?status=success
                                                          v
+---------------------------------------------------------------------------------------------------------+
|                                           Merchant Backend                                              |
|                                                                                                         |
|   +------------------------------------+            +-----------------------------------------------+   |
|   |         /bkash/callback            |            |                 /ipn/webhook                  |   |
|   |   - Validates status === 'success' |            |   - Verifies AWS SNS RSA-SHA1 Signature       |   |
|   |   - Calls /execute                 |            |   - Fetches & caches X.509 .pem cert          |   |
|   |   - Atomically records trxID       |            |   - Idempotently credits order wallet         |   |
|   +-----------------+------------------+            +-----------------------+-----------------------+   |
+---------------------|-------------------------------------------------------|---------------------------+
                      |                                                       ^
     2. execute       | 4. HTTP-200 Response                                  | 5. AWS SNS Webhook
        (paymentID)   |    { statusCode: "0000", trxID }                      |    (Signed Notification)
                      v                                                       |
+-----------------------------------------------------------------------------|---------------------------+
|                                              PaySim-BD                                                  |
|                                                                             |                           |
|   +-----------------------+           +--------------------------+          |                           |
|   |   Fastify API Server  |           |   SQLite WAL Database    |          |                           |
|   |   -----------------   |           |   --------------------   |          |                           |
|   |   - /token/grant      |           |   - payments             |          |                           |
|   |   - /checkout/create  | --------> |   - ipn_outbox (Leases)  | ---------+                           |
|   |   - /checkout/execute | (BEGIN    |   - tokens (1h/28d TTL)  |                                          |
|   |   - /payment/status   | IMMEDIATE)|   - events & chaos_rules |                                          |
|   +-----------------------+           +--------------------------+                                          |
|               |                                     ^                                                   |
|               | (Post-Commit Hook)                  | (Claim Leases & Dispatch)                         |
|               v                                     |                                                   |
|   +-------------------------------------------------+-----------------------+                           |
|   |                     Asynchronous IPN Outbox Worker                      |                           |
|   |   - Claims due rows with 30s crash-safe leases inside transactions      |                           |
|   |   - Exponential backoff (1s, 2s, 4s, 8s, 16s) up to 5 attempts          |                           |
|   |   - Signs envelopes with RSA-SHA1 & serves .well-known/paysim-sns.pem   |                           |
|   +-------------------------------------------------------------------------+                           |
+---------------------------------------------------------------------------------------------------------+
```

### Non-Negotiable Domain Invariants

1. **No Floating-Point Money:** Wire format (`amount`) is always a decimal string (e.g., `"500.00"`, `"20.50"`). Database storage (`amount_paisa`) is always an integer in paisa (`50000`, `2050`). No `parseFloat` arithmetic.
2. **Payment State Machine:**
   - Strict progression: `INITIATED` ➔ `APPROVED` (wallet approval) ➔ `COMPLETED`.
   - Terminal states: `FAILED`, `CANCELLED`, `EXPIRED`.
   - Calling `/execute` before `APPROVED` triggers `UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK`.
   - Calling `/execute` a second time on `COMPLETED` returns error `statusCode: "2062"` and never generates a second `trxID`.
3. **bKash HTTP-200 Error Envelope:**
   - Protocol/business failures return HTTP `200 OK` with `{ statusCode: "<non-0000>", statusMessage: "..." }`.
   - Success returns HTTP `200 OK` with `{ statusCode: "0000", statusMessage: "Successful", ... }`.
   - HTTP `401 Unauthorized` is reserved strictly for missing, expired, or invalid Bearer tokens.
4. **SQLite Transaction & Post-Commit Hook Discipline:**
   - Payment state updates (`UPDATE payments`) and outbox insertions (`INSERT INTO ipn_outbox`) execute atomically in a single synchronous transaction using `BEGIN IMMEDIATE`.
   - Gateway chaos hooks (such as `timeout-after-commit` or holding execute responses) execute **strictly after** the SQLite transaction commits. Database locks are never held during network I/O.
5. **Virtual Clock Injection:**
   - All domain, token expiry, and outbox leasing operations use an injected `Clock` interface (`clock.nowMs()`, `clock.nowIso()`), enabling instant, deterministic time-travel testing without `setTimeout` delays.

---

## 📋 Protocol Fidelity Matrix (Verified vs. Simulator-Defined)

Every feature in PaySim-BD is audited against real bKash documentation and verified SDKs. See [docs/protocol-verification.md](docs/protocol-verification.md) for verbatim evidence:

| Protocol Feature | Status | Primary Source & Verbatim Evidence | Classification |
| :--- | :---: | :--- | :--- |
| **Callback & Execute Flow** | Verified | *bKash Payment Gateway UAT Manual PDF* & *Irfan-Chowdhury/bkash-tokenized-checkout*: `/create` returns `bkashURL`, user approves with OTP/PIN, redirects to `callbackURL?status=success`, then execute is called. | **Verified Protocol** *(Headless auto-approve header is Simulator-Defined for CI)* |
| **bKash HTTP-200 Error Envelope** | Verified | *bKash UAT Manual Action Point #3*: *"For execute API statusCode 0000 is for success response rather than this for any other failure case you should display the proper status message... You always get a response with statusMessage."* | **Verified Protocol** |
| **Dual Token TTLs (1h / 28d)** | Verified | *bKash UAT Manual Page 4*: *"id_token: Valid for 1 hour. refresh_token: Valid for 28 days... Each time the id_token is refreshed, the validity of the refresh_token remains the same."* | **Verified Protocol** |
| **UAT Action Points #0 & #4** | Verified | *bKash UAT Manual Page 4*: Action Point #0 mandates 1-hour reuse of `id_token`. Action Point #4 mandates `/payment/status` only be called inside error blocks when execute gives no response. | **Verified Protocol** |
| **AWS SNS SignatureVersion 1** | Verified | Verified across 3 independent sources: bKash official PHP listener (`bKash-developer/webhook-endpoint-php`), Rust SDK (`bkash-rs` v0.2.1), and APIs.io catalog. RSA-SHA1 signing with `SigningCertURL`. | **Verified Protocol** *(Local dev X.509 cert and host allowlist are Simulator-Defined)* |
| **AsyncAPI Specification** | Verified | APIs.io Provider Catalog notes bKash publishes no official machine-readable spec; third-party contract derived from documented operations and sample listeners. | **Third-Party Derived** |
| **Sandbox Wallets, OTP & PIN** | Verified | Public in official UAT Manual: Success wallets (`01770618575`, `01619777283`, `01877722345`), Insufficient Balance (`01823074817`), Blocked (`01823074818`), OTP `123456`, PIN `12121`. | **Verified Protocol** |

---

## 📊 Measured Performance Benchmarks

Measured using the reproducible benchmark harness (`npm run benchmark`) on a local disk-backed SQLite database with Write-Ahead Logging (WAL). **All numbers are 100% measured—never estimated or invented.**

### Host Environment

| Property | Value |
| :--- | :--- |
| **CPU Model** | `AMD Ryzen 7 7700 8-Core Processor (16 logical cores)` |
| **RAM** | `15.60 GB` |
| **Operating System** | `Windows 11 (win32 10.0.26100, x64)` |
| **Node.js Runtime** | `v24.18.0` |
| **Database Engine** | `better-sqlite3 (synchronous C-API)` |
| **Storage Configuration** | `WAL Mode, synchronous = NORMAL, busy_timeout = 5000ms` |

### 1. Full Payment Lifecycle Throughput & Latency

Each lifecycle performs:
1. `POST /tokenized/checkout/create` (Request validation & state transition to `INITIATED`)
2. `POST /_paysim/checkout/:paymentID/action` (Simulated wallet OTP/PIN approval to `APPROVED`)
3. `POST /tokenized/checkout/execute` (Atomic `BEGIN IMMEDIATE` commit, state update to `COMPLETED`, deterministic `trxID` generation, AWS SNS RSA-SHA1 signature computation, and `ipn_outbox` disk insert)

> **Test Configuration:** 50-request warm-up, followed by **5 measured runs of 200 payments** (1,000 total payment lifecycles).

| Run | Count | Duration (s) | Throughput (req/s) | Min Latency (ms) | Median Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Max Latency (ms) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 200 | 8.831s | **23** | 7.58ms | 46.42ms | 47.86ms | 49.07ms | 50.68ms |
| **Run 2** | 200 | 9.154s | **22** | 23.22ms | 46.50ms | 47.86ms | 50.17ms | 51.03ms |
| **Run 3** | 200 | 9.112s | **22** | 23.02ms | 46.57ms | 48.06ms | 59.64ms | 157.15ms |
| **Run 4** | 200 | 8.873s | **23** | 6.66ms | 46.47ms | 47.99ms | 48.61ms | 58.73ms |
| **Run 5** | 200 | 9.047s | **22** | 4.97ms | 46.52ms | 48.01ms | 60.85ms | 62.52ms |
| **Aggregate** | **1,000** | **45.017s** | **22** | **4.97ms** | **46.48ms** | **48.00ms** | **51.03ms** | **157.15ms** |

### 2. Cryptographic RSA-SHA1 Verification & Deduplication Burst

Under concurrent burst load of **500 incoming webhooks**:
- **Workload:** RSA-SHA1 signature verification against public X.509 certificate + SQLite deduplication lookup & write.
- **Completed:** 500 operations in **0.048s**
- **Throughput:** **`10,455 ops/sec`**

---

## 💻 CLI Reference

PaySim-BD includes a command-line interface with subcommands for running the server, inspecting payment timelines, and auditing UAT compliance.

### 1. `paysim start`

Starts the HTTP simulator server and the background IPN delivery worker:
```bash
$ npx paysim start --port 8080 --db ./paysim.db

======================================================================
  PaySim-BD: bKash Tokenized Checkout & AWS SNS IPN Simulator v0.1.0  
======================================================================
Database:  ./paysim.db (WAL Mode)
HTTP Host: http://127.0.0.1:8080
Cert URL:  http://127.0.0.1:8080/.well-known/paysim-sns.pem
Worker:    Started (Lease: 30000ms, Max Attempts: 5)
```

### 2. `paysim events`

Renders a chronological ASCII table of all state transitions, API calls, and chaos injections for a payment:
```bash
$ npx paysim events TR0011B4FAEFD5314B40 --db ./paysim.db

---------------------------------------------------------------------------------------------------------
| Timestamp (ISO)          | Kind / Event                           | Payment ID           | Details      |
---------------------------------------------------------------------------------------------------------
| 2026-10-27T11:10:01.000Z | PAYMENT_INITIATED                      | TR0011B4FAEFD5314B40 | Normal       |
| 2026-10-27T11:10:01.045Z | PAYMENT_APPROVED                       | TR0011B4FAEFD5314B40 | Normal       |
| 2026-10-27T11:10:01.090Z | PAYMENT_EXECUTED                       | TR0011B4FAEFD5314B40 | Normal       |
| 2026-10-27T11:10:01.091Z | EXECUTE_TIMEOUT_AFTER_COMMIT           | TR0011B4FAEFD5314B40 | Chaos        |
| 2026-10-27T11:10:01.120Z | IPN_OUTBOX_DISPATCHED                  | TR0011B4FAEFD5314B40 | Normal       |
---------------------------------------------------------------------------------------------------------
```

### 3. `paysim lint`

Audits the database for any bKash UAT compliance violations. Exits with code `1` if violations are found (ideal as a CI gate for integration testing):
```bash
$ npx paysim lint --db ./paysim.db

================================================================================
                      PAYSIM-BD UAT COMPLIANCE AUDIT REPORT                     
================================================================================

  [FAIL] 3 UAT compliance violation(s) detected!

--------------------------------------------------------------------------------
 Violation #1: Redundant Token Grant (id_token not reused for 1 hour)
 Ref: Action Point #0 (UAT_RULE_1_REDUNDANT_TOKEN_GRANT)
 Problem: A new token was requested while an active id_token already exists.
 Remediation: Cache id_token and reuse for 1 hour across all user sessions.
--------------------------------------------------------------------------------
 Violation #2: Execute Called Without Customer Success Callback
 Ref: Action Point #2 (UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK)
 Problem: Execute API was invoked on a payment that was not in APPROVED state.
 Remediation: Only call execute inside callbackURL handler when status=success.
--------------------------------------------------------------------------------
 Violation #3: Unnecessary Query Payment Status Call
 Ref: Action Point #4 (UAT_RULE_4_UNNECESSARY_QUERY_STATUS)
 Problem: Query payment was invoked after execute already returned successfully.
 Remediation: Only call /payment/status inside error/timeout catch blocks.
================================================================================
 Result: FAILED (3 violation(s))
```

---

## 🛠️ Testing & Verification

PaySim-BD is verified with 12 comprehensive unit, integration, and failure resilience test suites:

```bash
# Typecheck TypeScript codebase
npx tsc --noEmit

# Run all 73 Vitest tests
npm test

# Build production bundle and copy certificate assets
npm run build
```

---

## 📄 License

MIT © [Tahmid Jawad Shafi](https://github.com/TahmidShafi)
