/**
 * PaySim-BD Embedded HTML Live Inspector
 * Single-file, zero-dependency Tailwind UI served at GET /_paysim/inspector
 */
export function renderInspectorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>PaySim-BD Live Telemetry & Chaos Inspector</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      darkMode: 'class',
      theme: {
        extend: {
          colors: {
            brand: '#E2136E', // bKash official brand pink
            slate: {
              850: '#151e2e',
              900: '#0f172a',
              950: '#090d16'
            }
          }
        }
      }
    }
  </script>
  <style>
    @keyframes pulse-slow {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .pulse-indicator { animation: pulse-slow 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
    pre { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
  </style>
</head>
<body class="bg-slate-900 text-slate-100 min-h-screen font-sans antialiased selection:bg-brand selection:text-white">
  <!-- Main Container -->
  <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">

    <!-- Top Navigation Header -->
    <header class="flex flex-col md:flex-row md:items-center md:justify-between border-b border-slate-800 pb-5 gap-4">
      <div class="flex items-center space-x-3">
        <div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-brand to-pink-500 flex items-center justify-center font-black text-xl shadow-lg shadow-pink-900/30">
          ৳
        </div>
        <div>
          <div class="flex items-center space-x-2">
            <h1 class="text-xl font-bold tracking-tight text-white">PaySim-BD Live Inspector</h1>
            <span class="text-xs px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 font-mono border border-slate-700">v1.1.0</span>
          </div>
          <p class="text-xs text-slate-400">bKash Tokenized Checkout & AWS SNS Webhook Telemetry</p>
        </div>
      </div>

      <div class="flex items-center space-x-3">
        <!-- Live SSE Status Indicator -->
        <div id="sse-badge" class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-slate-800 border border-slate-700 text-xs font-medium">
          <span id="sse-dot" class="w-2.5 h-2.5 rounded-full bg-amber-400 pulse-indicator"></span>
          <span id="sse-label" class="text-slate-300">Connecting SSE...</span>
        </div>

        <!-- UAT Status Pill -->
        <div id="uat-badge" class="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-700/60 text-xs font-medium text-emerald-300">
          <span class="w-2 h-2 rounded-full bg-emerald-400"></span>
          <span id="uat-label">UAT Audit: Passing</span>
        </div>

        <button onclick="fetchState()" class="p-1.5 text-slate-400 hover:text-white rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs" title="Refresh State">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"></path></svg>
        </button>
      </div>
    </header>

    <!-- Stat KPI Cards -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
      <div class="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 shadow-sm">
        <p class="text-xs font-medium text-slate-400 uppercase tracking-wider">Total Payments</p>
        <p id="stat-total-payments" class="text-2xl font-bold text-white mt-1">0</p>
        <div class="text-[11px] text-slate-500 mt-1">Tokenized checkouts</div>
      </div>

      <div class="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 shadow-sm">
        <p class="text-xs font-medium text-emerald-400 uppercase tracking-wider">Completed</p>
        <p id="stat-completed-payments" class="text-2xl font-bold text-emerald-300 mt-1">0</p>
        <div class="text-[11px] text-slate-500 mt-1">Executed & Settled</div>
      </div>

      <div class="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 shadow-sm">
        <p class="text-xs font-medium text-sky-400 uppercase tracking-wider">Outbox IPNs</p>
        <div class="flex items-baseline space-x-2 mt-1">
          <span id="stat-outbox-delivered" class="text-2xl font-bold text-sky-300">0</span>
          <span class="text-xs text-slate-400">delivered</span>
        </div>
        <div class="text-[11px] text-slate-400 mt-1 flex space-x-2">
          <span><b id="stat-outbox-pending" class="text-amber-400">0</b> pend</span>
          <span>&bull;</span>
          <span><b id="stat-outbox-retry" class="text-purple-400">0</b> retry</span>
          <span>&bull;</span>
          <span><b id="stat-outbox-dead" class="text-rose-400">0</b> dead</span>
        </div>
      </div>

      <div class="bg-slate-800/80 rounded-xl p-4 border border-slate-700/80 shadow-sm">
        <p class="text-xs font-medium text-amber-400 uppercase tracking-wider">UAT Violations</p>
        <p id="stat-total-violations" class="text-2xl font-bold text-white mt-1">0</p>
        <div id="stat-violations-sub" class="text-[11px] text-emerald-400 mt-1">0 technical rule issues</div>
      </div>
    </div>

    <!-- Action Toolbar (Trigger Offline, Clock Advance & Chaos Suite Runner) -->
    <div class="bg-slate-850 rounded-xl p-4 border border-slate-800 flex flex-wrap items-center justify-between gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <button onclick="runAllChaosScenarios()" id="btn-run-suite" class="px-4 py-2 rounded-xl bg-gradient-to-r from-brand to-pink-600 hover:from-pink-600 hover:to-pink-700 text-white font-bold text-xs shadow-lg shadow-pink-900/40 flex items-center space-x-2 transition transform active:scale-95">
          <span id="suite-spinner" class="hidden animate-spin">🔄</span>
          <span id="suite-icon">▶</span>
          <span id="suite-label">Run All 5 Chaos Scenarios</span>
        </button>

        <span class="text-xs font-semibold text-slate-500 uppercase tracking-wider hidden sm:inline">|</span>

        <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Offline:</span>
        <button onclick="triggerOffline('ussd')" class="px-3 py-1.5 rounded-lg bg-pink-600/20 hover:bg-pink-600/30 text-pink-300 border border-pink-500/30 text-xs font-medium flex items-center space-x-1.5 transition">
          <span>📱</span>
          <span>USSD (*247#)</span>
        </button>
        <button onclick="triggerOffline('qr')" class="px-3 py-1.5 rounded-lg bg-sky-600/20 hover:bg-sky-600/30 text-sky-300 border border-sky-500/30 text-xs font-medium flex items-center space-x-1.5 transition">
          <span>📷</span>
          <span>QR Payment</span>
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Advance Clock:</span>
        <button onclick="advanceClock(5)" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-mono transition">+5s</button>
        <button onclick="advanceClock(60)" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-mono transition">+1m</button>
        <button onclick="advanceClock(3600)" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-mono transition">+1h</button>
        <button onclick="advanceClock(86400)" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-xs font-mono transition">+24h</button>
      </div>
    </div>

    <!-- 5-Scenario Live Showcase Comparison Card -->
    <div id="suite-results-card" class="hidden bg-slate-850 rounded-xl p-5 border border-pink-700/50 shadow-xl space-y-4">
      <div class="flex items-center justify-between">
        <div class="flex items-center space-x-3">
          <span class="text-sm font-bold text-white">5-Scenario Chaos Matrix Verification</span>
          <span id="suite-status-pill" class="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-700">5/5 Verified</span>
        </div>
        <button onclick="document.getElementById('suite-results-card').classList.add('hidden')" class="text-slate-400 hover:text-white text-xs">✕ Dismiss</button>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-900 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
            <tr>
              <th class="p-3 w-12">#</th>
              <th class="p-3">Scenario</th>
              <th class="p-3">Injected Chaos Fault</th>
              <th class="p-3">Naive Result (Vulnerable)</th>
              <th class="p-3">Hardened Result (Resilient)</th>
              <th class="p-3 text-right">Status</th>
            </tr>
          </thead>
          <tbody id="suite-table-body" class="divide-y divide-slate-800">
          </tbody>
        </table>
      </div>
    </div>

    <!-- Notification Toast -->
    <div id="toast" class="hidden fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-xl text-xs font-medium border transition-all duration-300"></div>

    <!-- Tab Buttons -->
    <div class="flex border-b border-slate-800 space-x-4">
      <button onclick="switchTab('timeline')" id="tab-btn-timeline" class="py-2.5 px-4 text-sm font-semibold border-b-2 border-brand text-brand flex items-center space-x-2">
        <span>⚡ Live Event Timeline</span>
        <span id="events-count-badge" class="ml-1.5 px-2 py-0.5 text-[10px] rounded-full bg-slate-800 text-slate-300">0</span>
      </button>
      <button onclick="switchTab('outbox')" id="tab-btn-outbox" class="py-2.5 px-4 text-sm font-semibold border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center space-x-2">
        <span>📬 IPN Outbox & Replay Queue</span>
        <span id="outbox-count-badge" class="ml-1.5 px-2 py-0.5 text-[10px] rounded-full bg-slate-800 text-slate-300">0</span>
      </button>
      <button onclick="switchTab('uat')" id="tab-btn-uat" class="py-2.5 px-4 text-sm font-semibold border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center space-x-2">
        <span>🛡️ UAT Compliance Audit</span>
        <span id="uat-count-badge" class="ml-1.5 px-2 py-0.5 text-[10px] rounded-full bg-slate-800 text-slate-300">0</span>
      </button>
    </div>

    <!-- Tab 1: Live Event Timeline -->
    <div id="tab-timeline" class="space-y-3">
      <div class="flex justify-between items-center text-xs text-slate-400 px-1">
        <span>Real-time event log streamed over Server-Sent Events</span>
        <button onclick="clearTimelineUI()" class="text-slate-500 hover:text-slate-300 underline">Clear View</button>
      </div>
      <div id="timeline-list" class="space-y-2">
        <div class="text-center py-12 text-slate-500 text-sm">Listening for telemetry events...</div>
      </div>
    </div>

    <!-- Tab 2: IPN Outbox & Replay Queue -->
    <div id="tab-outbox" class="hidden space-y-3">
      <div class="flex justify-between items-center text-xs text-slate-400 px-1">
        <span>All AWS SNS Notifications queued and dispatched via Outbox Worker</span>
        <span class="text-xs text-slate-500">Click "Replay IPN" to simulate deterministic webhook redelivery</span>
      </div>
      <div class="bg-slate-800/60 rounded-xl border border-slate-700/80 overflow-x-auto shadow-sm">
        <table class="w-full text-left text-xs">
          <thead class="bg-slate-850 text-slate-400 uppercase tracking-wider font-semibold border-b border-slate-700">
            <tr>
              <th class="p-3">ID</th>
              <th class="p-3">Payment ID</th>
              <th class="p-3">Type</th>
              <th class="p-3">Status</th>
              <th class="p-3">Attempts</th>
              <th class="p-3">HTTP Code</th>
              <th class="p-3">Next Attempt</th>
              <th class="p-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody id="outbox-table-body" class="divide-y divide-slate-700/60">
            <tr><td colspan="8" class="text-center py-8 text-slate-500">No outbox items recorded yet</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tab 3: UAT Compliance Audit -->
    <div id="tab-uat" class="hidden space-y-4">
      <div id="uat-audit-container">
        <div class="p-6 rounded-xl bg-slate-800/40 border border-slate-700/60 text-center text-slate-400">
          Loading UAT compliance audit...
        </div>
      </div>
    </div>

  </div>

  <!-- Inspector Client JavaScript -->
  <script>
    let stateCache = { payments: [], outbox: [], events: [], violations: [], summary: {} };
    let currentTab = 'timeline';

    function showToast(message, type = 'success') {
      const toast = document.getElementById('toast');
      toast.className = 'fixed bottom-6 right-6 z-50 px-4 py-3 rounded-lg shadow-xl text-xs font-medium border transition-all duration-300 ' +
        (type === 'success' ? 'bg-emerald-950 border-emerald-600 text-emerald-200' : 'bg-rose-950 border-rose-600 text-rose-200');
      toast.textContent = message;
      toast.classList.remove('hidden');
      setTimeout(() => toast.classList.add('hidden'), 4000);
    }

    function switchTab(tab) {
      currentTab = tab;
      const tabs = ['timeline', 'outbox', 'uat'];
      tabs.forEach(t => {
        const el = document.getElementById('tab-' + t);
        const btn = document.getElementById('tab-btn-' + t);
        if (t === tab) {
          el.classList.remove('hidden');
          btn.className = 'py-2.5 px-4 text-sm font-semibold border-b-2 border-brand text-brand flex items-center space-x-2';
        } else {
          el.classList.add('hidden');
          btn.className = 'py-2.5 px-4 text-sm font-semibold border-b-2 border-transparent text-slate-400 hover:text-slate-200 flex items-center space-x-2';
        }
      });
    }

    function clearTimelineUI() {
      document.getElementById('timeline-list').innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">Timeline cleared. Waiting for events...</div>';
    }

    async function fetchState() {
      try {
        const res = await fetch('/_paysim/state');
        if (!res.ok) return;
        const data = await res.json();
        stateCache = data;
        renderSummary(data.summary);
        renderTimeline(data.events);
        renderOutbox(data.outbox);
        renderUat(data.violations);
      } catch (err) {
        console.error('Failed to load state:', err);
      }
    }

    function renderSummary(summary) {
      if (!summary) return;
      document.getElementById('stat-total-payments').textContent = summary.total_payments ?? 0;
      document.getElementById('stat-completed-payments').textContent = summary.completed_payments ?? 0;
      document.getElementById('stat-outbox-delivered').textContent = summary.outbox_delivered ?? 0;
      document.getElementById('stat-outbox-pending').textContent = summary.outbox_pending ?? 0;
      document.getElementById('stat-outbox-retry').textContent = summary.outbox_retry ?? 0;
      document.getElementById('stat-outbox-dead').textContent = summary.outbox_dead ?? 0;
      document.getElementById('stat-total-violations').textContent = summary.total_violations ?? 0;

      const uatLabel = document.getElementById('uat-label');
      const uatBadge = document.getElementById('uat-badge');
      const statViolationsSub = document.getElementById('stat-violations-sub');

      if ((summary.total_violations ?? 0) === 0) {
        uatLabel.textContent = 'UAT: 0 Violations (Passing)';
        uatBadge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full bg-emerald-950/60 border border-emerald-700/60 text-xs font-medium text-emerald-300';
        statViolationsSub.textContent = '0 technical rule issues';
        statViolationsSub.className = 'text-[11px] text-emerald-400 mt-1';
      } else {
        uatLabel.textContent = 'UAT: ' + summary.total_violations + ' Violations';
        uatBadge.className = 'flex items-center space-x-2 px-3 py-1.5 rounded-full bg-rose-950/60 border border-rose-700/60 text-xs font-medium text-rose-300';
        statViolationsSub.textContent = summary.total_violations + ' technical rule issues';
        statViolationsSub.className = 'text-[11px] text-rose-400 mt-1';
      }
    }

    function getKindBadgeClass(kind) {
      if (kind.startsWith('UAT_RULE_')) return 'bg-rose-950/80 text-rose-300 border-rose-700';
      if (kind.startsWith('CHAOS_')) return 'bg-amber-950/80 text-amber-300 border-amber-700';
      if (kind.includes('REPLAY') || kind.includes('OFFLINE')) return 'bg-purple-950/80 text-purple-300 border-purple-700';
      if (kind === 'PAYMENT_EXECUTED' || kind === 'IPN_DELIVERED') return 'bg-emerald-950/80 text-emerald-300 border-emerald-700';
      return 'bg-slate-800 text-slate-300 border-slate-700';
    }

    function createEventCardHtml(evt) {
      const timeIso = new Date(evt.ts).toLocaleTimeString();
      const badgeCls = getKindBadgeClass(evt.kind);
      const chaosBadge = evt.chaos_applied ? '<span class="px-1.5 py-0.5 rounded text-[10px] bg-amber-900/60 text-amber-300 border border-amber-700/60 font-mono">Chaos: ' + evt.chaos_applied + '</span>' : '';
      const pidText = evt.payment_id ? '<span class="font-mono text-slate-400">' + evt.payment_id + '</span>' : '<span class="text-slate-600">-</span>';

      return '<div class="bg-slate-800/60 rounded-lg p-3 border border-slate-700/70 text-xs hover:border-slate-600 transition space-y-2">' +
        '<div class="flex items-center justify-between">' +
          '<div class="flex items-center space-x-2">' +
            '<span class="px-2 py-0.5 rounded font-mono font-medium border text-[11px] ' + badgeCls + '">' + evt.kind + '</span>' +
            chaosBadge +
            pidText +
          '</div>' +
          '<span class="text-slate-500 font-mono text-[11px]">' + timeIso + '</span>' +
        '</div>' +
        (evt.response ? '<pre class="bg-slate-900/80 rounded p-2 text-[11px] text-slate-300 overflow-x-auto border border-slate-800 max-h-32">' + escapeHtml(evt.response) + '</pre>' : '') +
      '</div>';
    }

    function escapeHtml(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function renderTimeline(events) {
      document.getElementById('events-count-badge').textContent = events.length;
      if (!events || events.length === 0) {
        document.getElementById('timeline-list').innerHTML = '<div class="text-center py-8 text-slate-500 text-xs">No events recorded yet</div>';
        return;
      }
      document.getElementById('timeline-list').innerHTML = events.map(createEventCardHtml).join('');
    }

    function appendLiveEvent(evt) {
      const container = document.getElementById('timeline-list');
      const countBadge = document.getElementById('events-count-badge');
      countBadge.textContent = parseInt(countBadge.textContent || '0', 10) + 1;

      // If empty state text is showing, clear it
      if (container.children.length === 1 && container.children[0].textContent.includes('No events') || container.children[0]?.textContent.includes('Listening')) {
        container.innerHTML = '';
      }

      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = createEventCardHtml(evt);
      const card = tempDiv.firstElementChild;
      card.classList.add('ring-2', 'ring-brand', 'transition-all', 'duration-500');
      container.prepend(card);
      setTimeout(() => card.classList.remove('ring-2', 'ring-brand'), 1500);
    }

    function renderOutbox(outbox) {
      document.getElementById('outbox-count-badge').textContent = outbox.length;
      const tbody = document.getElementById('outbox-table-body');
      if (!outbox || outbox.length === 0) {
        tbody.innerHTML = '<tr><td colspan="8" class="text-center py-8 text-slate-500">No outbox items recorded yet</td></tr>';
        return;
      }

      tbody.innerHTML = outbox.map(item => {
        let statusBadge = 'bg-slate-700 text-slate-300';
        if (item.status === 'DELIVERED') statusBadge = 'bg-emerald-950 text-emerald-300 border-emerald-700';
        else if (item.status === 'PENDING') statusBadge = 'bg-sky-950 text-sky-300 border-sky-700';
        else if (item.status === 'RETRY') statusBadge = 'bg-purple-950 text-purple-300 border-purple-700';
        else if (item.status === 'DEAD') statusBadge = 'bg-rose-950 text-rose-300 border-rose-700';

        const nextAttempt = item.next_attempt_at ? new Date(item.next_attempt_at).toLocaleTimeString() : '-';
        const httpStatus = item.last_http_status ? '<span class="font-mono">' + item.last_http_status + '</span>' : '<span class="text-slate-500">-</span>';

        return '<tr class="hover:bg-slate-800/40 transition">' +
          '<td class="p-3 font-mono text-slate-400">#' + item.id + '</td>' +
          '<td class="p-3 font-mono text-slate-200">' + item.payment_id + '</td>' +
          '<td class="p-3 text-slate-400">' + item.sns_type + '</td>' +
          '<td class="p-3"><span class="px-2 py-0.5 rounded text-[10px] font-semibold border ' + statusBadge + '">' + item.status + '</span></td>' +
          '<td class="p-3 font-mono text-slate-300">' + (item.attempts ?? 0) + '</td>' +
          '<td class="p-3">' + httpStatus + '</td>' +
          '<td class="p-3 font-mono text-slate-400">' + nextAttempt + '</td>' +
          '<td class="p-3 text-right">' +
            '<button onclick="replayOutbox(' + item.id + ')" class="px-2.5 py-1 rounded bg-brand/20 hover:bg-brand/40 text-pink-300 border border-brand/40 text-[11px] font-medium transition shadow-sm">' +
              'Replay IPN' +
            '</button>' +
          '</td>' +
        '</tr>';
      }).join('');
    }

    function renderUat(violations) {
      document.getElementById('uat-count-badge').textContent = violations.length;
      const container = document.getElementById('uat-audit-container');
      if (!violations || violations.length === 0) {
        container.innerHTML = '<div class="p-8 rounded-xl bg-emerald-950/20 border border-emerald-800/40 text-center space-y-2">' +
          '<div class="text-3xl">✅</div>' +
          '<h3 class="text-base font-bold text-emerald-300">0 UAT Violations Detected</h3>' +
          '<p class="text-xs text-slate-400 max-w-lg mx-auto">All merchant API operations strictly comply with verified bKash Technical Acceptance Action Points (Rule 1 Token Reuse, Rule 2 Execute Sequence, Rule 4 Query Guardrails).</p>' +
        '</div>';
        return;
      }

      container.innerHTML = '<div class="space-y-4">' +
        violations.map((v, idx) => {
          return '<div class="p-4 rounded-xl bg-slate-800/80 border border-rose-800/50 space-y-3 shadow-sm">' +
            '<div class="flex items-start justify-between">' +
              '<div class="space-y-1">' +
                '<div class="flex items-center space-x-2">' +
                  '<span class="px-2 py-0.5 rounded bg-rose-950 text-rose-300 border border-rose-800 font-mono text-[10px] font-bold">#' + (idx + 1) + ' ' + v.actionPoint + '</span>' +
                  '<span class="text-xs font-mono text-slate-400">' + v.rule + '</span>' +
                '</div>' +
                '<h4 class="text-sm font-bold text-white">' + v.title + '</h4>' +
              '</div>' +
              '<span class="text-slate-500 font-mono text-[11px]">' + new Date(v.ts).toLocaleTimeString() + '</span>' +
            '</div>' +
            '<p class="text-xs text-slate-300 leading-relaxed">' + v.description + '</p>' +
            '<div class="p-3 rounded-lg bg-slate-900 border border-slate-700/80 text-xs space-y-1">' +
              '<span class="text-amber-400 font-semibold block text-[11px] uppercase tracking-wider">Required Technical Remediation:</span>' +
              '<p class="text-slate-300">' + v.remediation + '</p>' +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>';
    }

    async function replayOutbox(id) {
      try {
        const res = await fetch('/_paysim/outbox/' + id + '/replay', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
          showToast('Webhook replayed! Enqueued Outbox #' + data.newOutboxId + ' for immediate delivery', 'success');
          await fetchState();
        } else {
          showToast('Failed to replay: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Error replaying outbox: ' + err.message, 'error');
      }
    }

    async function runAllChaosScenarios() {
      const btn = document.getElementById('btn-run-suite');
      const spinner = document.getElementById('suite-spinner');
      const icon = document.getElementById('suite-icon');
      const label = document.getElementById('suite-label');

      btn.disabled = true;
      btn.classList.add('opacity-75');
      spinner.classList.remove('hidden');
      icon.classList.add('hidden');
      label.textContent = 'Executing 5 Scenarios...';
      showToast('Executing all 5 chaos scenarios against live demo merchant...', 'success');

      try {
        const res = await fetch('/_paysim/demo/run-suite', { method: 'POST' });
        const data = await res.json();
        if (data.success && data.results) {
          renderSuiteResults(data.results);
          showToast('Completed! All 5 Scenarios verified Naive vs. Hardened architecture.', 'success');
          await fetchState();
        } else {
          showToast('Failed to run suite: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        showToast('Error running suite: ' + err.message, 'error');
      } finally {
        btn.disabled = false;
        btn.classList.remove('opacity-75');
        spinner.classList.add('hidden');
        icon.classList.remove('hidden');
        label.textContent = 'Run All 5 Chaos Scenarios';
      }
    }

    function renderSuiteResults(results) {
      const container = document.getElementById('suite-results-card');
      const tbody = document.getElementById('suite-table-body');
      const pill = document.getElementById('suite-status-pill');

      const allPassed = results.every(r => r.passed);
      pill.textContent = (results.filter(r => r.passed).length) + '/' + results.length + ' Verified';
      pill.className = allPassed
        ? 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-950 text-emerald-300 border border-emerald-700'
        : 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-950 text-amber-300 border border-amber-700';

      tbody.innerHTML = results.map(r => {
        return '<tr class="hover:bg-slate-800/40 transition">' +
          '<td class="p-3 font-mono font-bold text-slate-400">#' + r.scenario + '</td>' +
          '<td class="p-3 font-semibold text-white">' + escapeHtml(r.name) + '</td>' +
          '<td class="p-3 font-mono text-slate-300">' + escapeHtml(r.chaosFault) + '</td>' +
          '<td class="p-3 text-rose-400 font-mono text-[11px]">' + escapeHtml(r.naiveResult) + '</td>' +
          '<td class="p-3 text-emerald-400 font-mono text-[11px]">' + escapeHtml(r.hardenedResult) + '</td>' +
          '<td class="p-3 text-right"><span class="px-2 py-0.5 rounded text-[10px] font-bold ' +
            (r.passed ? 'bg-emerald-950 text-emerald-300 border border-emerald-700' : 'bg-rose-950 text-rose-300 border border-rose-700') +
          '">' + (r.passed ? 'PASS' : 'FAIL') + '</span></td>' +
        '</tr>';
      }).join('');

      container.classList.remove('hidden');
      container.scrollIntoView({ behavior: 'smooth' });
    }

    async function triggerOffline(channel) {
      const amount = prompt('Enter offline ' + channel.toUpperCase() + ' amount in BDT:', channel === 'ussd' ? '150.00' : '250.00');
      if (!amount) return;

      try {
        const res = await fetch('/_paysim/trigger/offline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel,
            amount,
            merchantInvoiceNumber: 'INV-' + channel.toUpperCase() + '-' + Date.now()
          })
        });
        const data = await res.json();
        if (data.success) {
          showToast('Simulated ' + channel.toUpperCase() + ' payment (' + data.trxID + ') queued for IPN delivery!', 'success');
          await fetchState();
        } else {
          showToast('Error: ' + (data.error || 'Trigger failed'), 'error');
        }
      } catch (err) {
        showToast('Offline trigger failed: ' + err.message, 'error');
      }
    }

    async function advanceClock(seconds) {
      try {
        const res = await fetch('/_paysim/clock/advance', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ seconds })
        });
        const data = await res.json();
        showToast('Advanced clock +' + seconds + 's -> ' + (data.nowIso || ''), 'success');
        await fetchState();
      } catch (err) {
        showToast('Clock advance failed: ' + err.message, 'error');
      }
    }

    function initSSE() {
      const sseDot = document.getElementById('sse-dot');
      const sseLabel = document.getElementById('sse-label');
      const eventSource = new EventSource('/_paysim/events/stream');

      eventSource.onopen = () => {
        sseDot.className = 'w-2.5 h-2.5 rounded-full bg-emerald-400';
        sseLabel.textContent = 'SSE: Connected';
        sseLabel.className = 'text-emerald-300';
      };

      eventSource.onerror = () => {
        sseDot.className = 'w-2.5 h-2.5 rounded-full bg-amber-400 pulse-indicator';
        sseLabel.textContent = 'SSE: Reconnecting...';
        sseLabel.className = 'text-amber-300';
      };

      eventSource.onmessage = (e) => {
        try {
          const evt = JSON.parse(e.data);
          appendLiveEvent(evt);
          fetchState(); // Re-sync summary counters & outbox
        } catch (err) {
          // heartbeat or non-json comment
        }
      };
    }

    // Initial load
    fetchState();
    initSSE();
  </script>
</body>
</html>`;
}

