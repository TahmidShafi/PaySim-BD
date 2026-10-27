# PaySim-BD Performance Benchmark Report

Measured on **2026-10-27** using local disk-backed SQLite with Write-Ahead Logging (WAL).

## Host Hardware & Environment

| Property | Value |
| :--- | :--- |
| **CPU Model** | `AMD Ryzen 7 7700 8-Core Processor              ` |
| **Logical Cores** | `16` |
| **RAM** | `15.60 GB` |
| **Operating System** | `win32 10.0.26100 (x64)` |
| **Node.js Runtime** | `v24.18.0` |
| **Database Engine** | `better-sqlite3 (synchronous C-API)` |
| **Storage Configuration** | `WAL (Write-Ahead Logging), synchronous = NORMAL, busy_timeout = 5000ms` |

## 1. Full Payment Lifecycle Throughput & Latency

Each payment lifecycle includes:
1. `POST /tokenized/checkout/create` (Validation, schema parsing, state transition to `INITIATED`)
2. `POST /_paysim/checkout/:paymentID/action` (Simulated wallet OTP/PIN approval to `APPROVED`)
3. `POST /tokenized/checkout/execute` (Atomic `BEGIN IMMEDIATE` transaction, state update to `COMPLETED`, deterministic `trxID` generation, AWS SNS RSA-SHA1 signature computation, and `ipn_outbox` insertion)

> **Test Configuration:** 50-request warm-up, followed by **5 measured runs of 200 payments** (1,000 total lifecycles).

| Run | Count | Duration (s) | Throughput (req/s) | Min Latency (ms) | Median Latency (ms) | p95 Latency (ms) | p99 Latency (ms) | Max Latency (ms) |
| :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| **Run 1** | 200 | 8.831s | **23** | 7.58ms | 46.42ms | 47.86ms | 49.07ms | 50.68ms |
| **Run 2** | 200 | 9.154s | **22** | 23.22ms | 46.50ms | 47.86ms | 50.17ms | 51.03ms |
| **Run 3** | 200 | 9.112s | **22** | 23.02ms | 46.57ms | 48.06ms | 59.64ms | 157.15ms |
| **Run 4** | 200 | 8.873s | **23** | 6.66ms | 46.47ms | 47.99ms | 48.61ms | 58.73ms |
| **Run 5** | 200 | 9.047s | **22** | 4.97ms | 46.52ms | 48.01ms | 60.85ms | 62.52ms |
| **Aggregate** | **1,000** | **45.017s** | **22** | **4.97ms** | **46.48ms** | **48.00ms** | **51.03ms** | **157.15ms** |

## 2. SNS RSA-SHA1 Signature Verification & SQLite Deduplication Burst

Under concurrent burst load of **500 incoming webhooks**:
- **Workload:** Cryptographic RSA-SHA1 signature verification against X.509 certificate public key + SQLite idempotent deduplication query.
- **Operations:** `500`
- **Total Duration:** `0.048s`
- **Throughput:** **`10455 ops/sec`**
