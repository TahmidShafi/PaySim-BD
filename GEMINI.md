# PaySim-BD Workspace Rules & Architectural Invariants

You are building **PaySim-BD**, a local CLI and chaos webhook simulator for Bangladesh's bKash Tokenized Checkout and AWS SNS-style Instant Payment Notifications (IPN).

Protocol reference: @[Protocol Verification](docs/protocol-verification.md)

## 1. Strict Working Agreement (Anti-Scope-Creep)
- **ONLY implement the exact Day/Milestone requested in the user's prompt.** Never jump ahead to future weeks or unrequested features.
- Before writing code for any multi-file task, generate a concise implementation Artifact/Plan and list the exact files you will create or touch.
- Every task MUST include Vitest tests (`tests/unit` or `tests/integration`) and pass `npm test` and `tsc --noEmit` before you declare the task complete.

## 2. Tech Stack & Code Standards
- **Runtime & Language:** Node.js 22+, TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), ESM.
- **HTTP Server:** `fastify`
- **Database:** `better-sqlite3` (synchronous API). MUST run with `PRAGMA journal_mode = WAL;`, `PRAGMA busy_timeout = 5000;`, and `PRAGMA foreign_keys = ON;`.
- **Validation:** `zod` for all request/response and chaos rule schemas.
- **Testing:** `vitest`

## 3. Non-Negotiable Domain Invariants
1. **No Floating-Point Money:** Wire format (`amount`) is ALWAYS a decimal string (e.g., `"500"`, `"20.50"`). Database storage (`amount_paisa`) is ALWAYS an integer in paisa (`50000`, `2050`). Never use `parseFloat` or floating-point math for money.
2. **Payment State Machine:**
   - States: `INITIATED` -> `APPROVED` (internal state after wallet approval) -> `COMPLETED`, plus terminal states `FAILED`, `CANCELLED`, `EXPIRED`.
   - Calling `/execute` before `APPROVED` MUST fail and record UAT violation `UAT_RULE_2_EXECUTE_WITHOUT_SUCCESS_CALLBACK`.
   - Calling `/execute` a second time on a `COMPLETED` payment MUST return an error and NEVER generate a second `trxID`.
3. **bKash HTTP-200 Error Envelope:**
   - Business/state errors return HTTP `200 OK` with `{ statusCode: "<non-0000>", statusMessage: "..." }`.
   - Success returns HTTP `200 OK` with `{ statusCode: "0000", statusMessage: "Successful", ... }`.
   - Reserve HTTP `401 Unauthorized` strictly for missing, invalid, or expired Bearer `id_token`.
4. **SQLite Transaction & Post-Commit Hook Discipline:**
   - State transitions (`UPDATE payments`) and outbox insertions (`INSERT INTO ipn_outbox`) MUST happen inside a single synchronous `db.transaction(...)` using `BEGIN IMMEDIATE`.
   - Gateway chaos hooks (like `timeout-after-commit` or holding the `/execute` response so the IPN arrives first) MUST run **AFTER** the SQLite transaction commits and wakes the outbox worker. Never hold a SQLite transaction open while sleeping or waiting on network I/O.
5. **Virtual Clock:**
   - Never call `Date.now()` directly in domain, token, or worker logic. Always use the injected `Clock` interface (`clock.nowMs()`, `clock.nowIso()`).