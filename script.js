/* ══════════════════════════════════════════
   FINTRACK — script.js  (v4 — system-correct)
   Pure Vanilla JS — No dependencies
══════════════════════════════════════════ */

'use strict';

// ─────────────────────────────────────────
// STORAGE KEYS
// ─────────────────────────────────────────

const KEY_EXPENSES      = 'ft_expenses_v3';
const KEY_SUMMARIES     = 'ft_summaries_v3';
const KEY_INCOME_MONTHS = 'ft_income_months_v4'; // { "YYYY-MM": number }
const KEY_CC            = 'ft_cc_v3';
const KEY_INIT          = 'ft_initialized_v4';   // bumped — triggers re-seed on fresh installs
const KEY_INCOME_LEGACY = 'ft_income_v3';         // read-only migration source
const KEY_TXN_ARCHIVE   = 'ft_txn_archive_v4';    // { "YYYY-MM": [transactions] } — for report export
const KEY_SAVINGS_MONTHS = 'ft_savings_months_v1';

// ─────────────────────────────────────────
// CATEGORIES
// ─────────────────────────────────────────

const CATEGORIES = [
  { id: 'food',          label: 'Food',     icon: '🍽️', color: '#EF4444' },
  { id: 'travel',        label: 'Travel',   icon: '✈️',  color: '#3B82F6' },
  { id: 'shopping',      label: 'Shopping', icon: '🛍️', color: '#F59E0B' },
  { id: 'entertainment', label: 'Entmnt',   icon: '🎬', color: '#8B5CF6' },
  { id: 'health',        label: 'Health',   icon: '💊', color: '#10B981' },
  { id: 'bills',         label: 'Bills',    icon: '📄', color: '#6B7280' },
  { id: 'misc',          label: 'Misc',     icon: '📦', color: '#EC4899' },
  { id: 'other',         label: 'Other',    icon: '💡', color: '#0EA5E9' },
];

// ─────────────────────────────────────────
// STATE  — single source of truth in memory.
//          localStorage is persistence only.
//
// _expenses  : real transactions for current
//              month only (no placeholders).
// _summaries : immutable snapshots of past
//              months — never mutated after
//              creation.
// _ccData    : fully independent CC tracker.
// ─────────────────────────────────────────

let _expenses      = [];
let _summaries     = [];
let _ccData        = { limit: 0, transactions: [] };
let _selectedCat   = 'food';
let _ccSelectedCat = 'shopping';
let _selectedType  = 'expense';
let _currentScreen = 'screen-dashboard';
let _lastId        = 0;

// ─────────────────────────────────────────
// UNIQUE ID GENERATION
// Monotonically increasing — safe even if
// two saves happen within the same ms.
// ─────────────────────────────────────────

function generateId() {
  const ts = Date.now();
  _lastId  = ts > _lastId ? ts : _lastId + 1;
  return _lastId;
}

// ─────────────────────────────────────────
// PER-MONTH INCOME
//
// Income is stored as a YYYY-MM → number map.
// Each month has its own value so that:
//   • Changing income in the current month
//     does NOT retroactively alter any past
//     summary (summaries already baked their
//     income value in at snapshot time).
//   • Summary generation uses the income for
//     the month being archived, not today's.
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// SAVINGS (PER MONTH)
// ─────────────────────────────────────────

function _loadSavingsMap() {
  try {
    const raw = localStorage.getItem(KEY_SAVINGS_MONTHS);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

function _saveSavingsMap(map) {
  localStorage.setItem(KEY_SAVINGS_MONTHS, JSON.stringify(map));
}

function getSavingsForMonth(mk) {
  const map = _loadSavingsMap();
  return Number(map[mk]) || 0;
}

function setSavingsForMonth(mk, value) {
  const map = _loadSavingsMap();
  map[mk] = Math.max(0, Number(value) || 0);
  _saveSavingsMap(map);
}

const DEFAUKT_INCOME = 1000;
/** Load the full { "YYYY-MM": number } map from storage */
function _loadIncomeMap() {
  try {
    const raw = localStorage.getItem(KEY_INCOME_MONTHS);
    const map = raw ? JSON.parse(raw) : {};
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    // Coerce all values to numbers
    const clean = {};
    Object.entries(map).forEach(([k, v]) => { clean[k] = Number(v) || 0; });
    return clean;
  } catch { return {}; }
}

function _saveIncomeMap(map) {
  localStorage.setItem(KEY_INCOME_MONTHS, JSON.stringify(map));
}

/**
 * Get the income for a specific month key.
 * Falls back: per-month map → legacy single value → default.
 */
function getIncomeForMonth(mk) {
  const map = _loadIncomeMap();
  if (map[mk] !== undefined) return map[mk];
  // Migration fallback: read the old single-value key
  const legacy = parseFloat(localStorage.getItem(KEY_INCOME_LEGACY) || '0');
  return legacy > 0 ? legacy : DEFAULT_INCOME;
}

/** Get income for the current month */
function getIncome() {
  return getIncomeForMonth(currentMonthKey());
}

/**
 * Set income for the current month ONLY.
 * Past month income values in summaries are
 * already frozen — this cannot touch them.
 */
function setIncome(v) {
  const map   = _loadIncomeMap();
  map[currentMonthKey()] = Number(v) || 0;
  _saveIncomeMap(map);
}

/**
 * Seed income for a specific month if not
 * already present (used by first-launch init
 * and transition when no explicit value set).
 */
function seedIncomeForMonth(mk, v) {
  const map = _loadIncomeMap();
  if (map[mk] === undefined) {
    map[mk] = Number(v) || DEFAULT_INCOME;
    _saveIncomeMap(map);
  }
}

// ─────────────────────────────────────────
// STORAGE — load / save
// ─────────────────────────────────────────

function loadAll() {
  // ── Expenses ──────────────────────────
  try {
    const raw = localStorage.getItem(KEY_EXPENSES);
    let parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) parsed = [];

    // Strip legacy placeholder entries — placeholder is now UI-only
    parsed = parsed.filter(e => !e.isPlaceholder);

    // Enforce schema: amounts must be numbers, type must exist
    _expenses = parsed.map(e => ({
      id:       e.id,
      amount:   Math.round((Number(e.amount) || 0) * 100) / 100,
      category: String(e.category || 'other'),
      note:     String(e.note     || ''),
      date:     String(e.date     || new Date().toISOString()),
      type:     e.type === 'income' ? 'income' : 'expense',
    }));
  } catch { _expenses = []; }

  // ── Summaries ─────────────────────────
  try {
    const raw = localStorage.getItem(KEY_SUMMARIES);
    let parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) parsed = [];

    _summaries = parsed.map(s => ({
      monthKey:   String(s.monthKey   || ''),
      income:     Number(s.income)    || 0,
      expense:    Number(s.expense)   || 0,
      savings:    Number(s.savings)   || 0,
      // Coerce each category value to a number
      categories: Object.fromEntries(
        Object.entries(s.categories || {}).map(([k, v]) => [k, Number(v) || 0])
      ),
    }));

    // Deduplicate by monthKey (keep first occurrence)
    const seen = new Set();
    _summaries = _summaries.filter(s => {
      if (!s.monthKey || seen.has(s.monthKey)) return false;
      seen.add(s.monthKey);
      return true;
    });
  } catch { _summaries = []; }

  // ── Credit Card ───────────────────────
  try {
    const raw = localStorage.getItem(KEY_CC);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') {
      _ccData = { limit: 0, transactions: [] };
    } else {
      _ccData = {
        limit: Number(parsed.limit) || 0,
        transactions: Array.isArray(parsed.transactions)
          ? parsed.transactions.map(e => ({
              id:       e.id,
              amount:   Math.round((Number(e.amount) || 0) * 100) / 100,
              category: String(e.category || 'other'),
              note:     String(e.note     || ''),
              date:     String(e.date     || new Date().toISOString()),
            }))
          : [],
      };
    }
  } catch { _ccData = { limit: 0, transactions: [] }; }
}

function saveExpenses()  { localStorage.setItem(KEY_EXPENSES,  JSON.stringify(_expenses));  }
function saveSummaries() { localStorage.setItem(KEY_SUMMARIES, JSON.stringify(_summaries)); }
function saveCC()        { localStorage.setItem(KEY_CC,        JSON.stringify(_ccData));    }

// Transaction archive — stores raw txns per past month so the
// export feature can include them in the backup JSON / PDF.
// Read/written only during transition and export; never affects
// any calculation or in-memory state.
function _loadTxnArchive() {
  try {
    const raw = localStorage.getItem(KEY_TXN_ARCHIVE);
    const obj = raw ? JSON.parse(raw) : {};
    return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
  } catch { return {}; }
}
function _saveTxnArchive(archive) {
  localStorage.setItem(KEY_TXN_ARCHIVE, JSON.stringify(archive));
}
/** Returns archived transactions for a past month, or [] if not stored. */
function getArchivedTransactions(mk) {
  const archive = _loadTxnArchive();
  return Array.isArray(archive[mk]) ? archive[mk] : [];
}

// ─────────────────────────────────────────
// DATE HELPERS — all LOCAL timezone, never UTC
//
// .toISOString() is UTC. In IST (UTC+5:30),
// events after 18:30 local → next UTC day.
// All date extraction uses getFullYear() /
// getMonth() / getDate() (local TZ).
// ─────────────────────────────────────────

function localDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return (
    dt.getFullYear()                           + '-' +
    String(dt.getMonth() + 1).padStart(2, '0') + '-' +
    String(dt.getDate()).padStart(2, '0')
  );
}

function localMonthStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return (
    dt.getFullYear()                           + '-' +
    String(dt.getMonth() + 1).padStart(2, '0')
  );
}

function todayStr()        { return localDateStr(new Date()); }
function currentMonthKey() { return localMonthStr(new Date()); }

/** "YYYY-MM" for any ISO/Date value — local TZ */
function monthKey(isoStr) {
  if (!isoStr) return '';
  return localMonthStr(new Date(isoStr));
}

/** "YYYY-MM-DD" for any ISO/Date value — local TZ */
function dateOnly(isoStr) {
  if (!isoStr) return '';
  return localDateStr(new Date(isoStr));
}

/**
 * Build an ISO timestamp from a date-input value + current wall-clock time.
 * Constructs as local time string (no trailing Z) so new Date() parses it
 * in local TZ, then serialises to UTC ISO. This means the stored ISO string
 * correctly round-trips back to the right local date on any read.
 */
function buildISOTimestamp(dateValue) {
  const now      = new Date();
  const localStr = dateValue
    + 'T'
    + String(now.getHours()).padStart(2, '0')   + ':'
    + String(now.getMinutes()).padStart(2, '0') + ':'
    + String(now.getSeconds()).padStart(2, '0');
  return new Date(localStr).toISOString();
}

function formatDateGroupLabel(dk) {
  const today     = todayStr();
  const yesterday = localDateStr(new Date(Date.now() - 86_400_000));
  if (dk === today)     return 'Today';
  if (dk === yesterday) return 'Yesterday';
  return new Date(dk + 'T12:00:00').toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

function formatTime(isoStr) {
  return new Date(isoStr).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function monthDisplayName(mk) {
  const [yr, mo] = mk.split('-');
  return new Date(+yr, +mo - 1, 1).toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric',
  });
}

// ─────────────────────────────────────────
// FORMATTING
// ─────────────────────────────────────────

function fmtFull(amount) {
  const n = Math.abs(Number(amount) || 0);
  return '₹' + n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

function getCat(id) {
  return CATEGORIES.find(c => c.id === id)
    || { id: 'other', label: id || 'Other', icon: '💡', color: '#0EA5E9' };
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

// ─────────────────────────────────────────
// FIRST-LAUNCH SEED
// Runs exactly once per clean install.
// Sets up pre-seeded Feb/March summaries and
// seeds the current month's income value.
// Does NOT create any placeholder entry in
// _expenses — placeholder is UI-only.
// ─────────────────────────────────────────

function initFirstLaunch() {
  if (localStorage.getItem(KEY_INIT)) return;

  const now       = new Date();
  const currentMo = now.getMonth() + 1;         // 1-indexed
  const refYear   = currentMo >= 4 ? now.getFullYear() : now.getFullYear() - 1;

  // Seed per-month income for current month and the two seeded past months
  const cmk = currentMonthKey();
  seedIncomeForMonth(cmk,                  DEFAULT_INCOME);
  seedIncomeForMonth(`${refYear}-03`,      DEFAULT_INCOME);
  seedIncomeForMonth(`${refYear}-02`,      DEFAULT_INCOME);

  // Pre-seeded past-month summaries (immutable from this point on)
  _summaries = [
    {
      monthKey:   `${refYear}-03`,
      income:     DEFAULT_INCOME,
      expense:    12000,
      savings:    12000,
      categories: { food: 4200, travel: 2500, bills: 2800, misc: 1500, other: 1000 },
    },
    {
      monthKey:   `${refYear}-02`,
      income:     DEFAULT_INCOME,
      expense:    17200,
      savings:    6800,
      categories: { food: 5500, travel: 3200, shopping: 4000, bills: 3000, entertainment: 1500 },
    },
  ];
  saveSummaries();

  // Start with empty expenses for the current month
  _expenses = [];
  saveExpenses();

  // Clean CC state
  _ccData = { limit: 0, transactions: [] };
  saveCC();

  localStorage.setItem(KEY_INIT, '1');
}

// ─────────────────────────────────────────
// MONTH TRANSITION
//
// Runs at every startup. Finds any transactions
// in _expenses that belong to a past month,
// aggregates them into a frozen summary, then
// removes them from the live _expenses array.
//
// Key properties:
//   • Idempotent — existing summaries are never
//     overwritten (monthKey uniqueness check).
//   • Uses getIncomeForMonth(mk) — the income
//     for THAT month, not today's income.
//     This guarantees summaries are frozen even
//     if the user later changes their income.
//   • After archiving, those transactions are
//     removed from _expenses permanently.
// ─────────────────────────────────────────

function handleMonthTransition() {
  const cmk  = currentMonthKey();

  // All real transactions belonging to any past month
  const past = _expenses.filter(e => monthKey(e.date) !== cmk);
  if (!past.length) return;

  // Group past transactions by their month
  const byMonth = {};
  past.forEach(e => {
    const mk = monthKey(e.date);
    (byMonth[mk] = byMonth[mk] || []).push(e);
  });

  Object.entries(byMonth).forEach(([mk, txns]) => {
    // Idempotency guard — never create a duplicate or overwrite a frozen summary
    if (_summaries.some(s => s.monthKey === mk)) return;

    const exps    = txns.filter(e => e.type === 'expense');
    const incs    = txns.filter(e => e.type === 'income');

    // totalEx and category totals: computed from raw transactions only
    const totalEx = exps.reduce((s, e) => s + Number(e.amount), 0);

    const catTot = {};
    exps.forEach(e => {
      catTot[e.category] = (catTot[e.category] || 0) + Number(e.amount);
    });

    // totalIn = base salary for THAT month + any explicit income entries for that month
    // Uses per-month income so changing income today cannot alter this.
    const baseIncome = getIncomeForMonth(mk);
    const extraInc   = incs.reduce((s, e) => s + Number(e.amount), 0);
    const totalIn    = baseIncome + extraInc;

    // Push the frozen snapshot
     const storedSavings = getSavingsForMonth(mk);
    _summaries.push({
      monthKey:   mk,
      income:     totalIn,
      expense:    totalEx,
      savings: storedSavings || (totalIn - totalEx),
      categories: catTot,
    });

    // Archive raw transactions for this month so the export feature
    // can include them in the PDF / JSON backup.  Idempotent: only
    // written once (same guard as the summary above).
    const archive = _loadTxnArchive();
    if (!archive[mk]) {
      archive[mk] = txns.map(e => ({
        id:       e.id,
        amount:   e.amount,
        category: e.category,
        note:     e.note     || '',
        date:     e.date,
        type:     e.type,
      }));
      _saveTxnArchive(archive);
    }
  });

  // Prune archived transactions — only keep current-month entries
  _expenses = _expenses.filter(e => monthKey(e.date) === cmk);

  saveExpenses();
  saveSummaries();
}

// ─────────────────────────────────────────
// CENTRAL RENDER
// Single dispatch point. Every save/delete
// operation calls render() once. UI always
// reflects the current in-memory state.
// ─────────────────────────────────────────

function render() {
  try {
    switch (_currentScreen) {
      case 'screen-dashboard':
        renderDashboard();
        break;

      case 'screen-transactions':
        renderTransactions();
        break;

      case 'screen-summary':
        renderSummary();
        break;

      case 'screen-cc':
        renderCCScreen();
        break;

      default:
        console.warn('Unknown screen:', _currentScreen);
        renderDashboard();
    }
  } catch (err) {
    console.error('Render crash:', err);
  }
}

// ─────────────────────────────────────────
// INIT
// ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  try {
    loadAll();

    // defer rest to ensure DOM + storage stable
    setTimeout(() => {
      try {
        initFirstLaunch();
        handleMonthTransition();

        setupGreeting();
        console.log("setupNav running");
        setupNav();
        console.log("setupAddForm running");
        setupAddForm();
        console.log("setupAddForm running");
        setupIncomeModal();
        console.log("setupIncomeModal running");
        setupCCScreen();

        render();
      } catch (e) {
        console.error('Init inner failed:', e);
      }
    }, 50);

  } catch (e) {
    console.error('Init failed:', e);
  }
});

function setupGreeting() {
  const h  = new Date().getHours();
  const g  = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const el = document.getElementById('header-greeting');
  if (el) el.textContent = g;
}

// ─────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────

function setupNav() {
  document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
    btn.addEventListener('click', () => {
      showScreen(btn.dataset.screen);
      render();
    });
  });

  document.getElementById('btn-back-add').addEventListener('click', () => {
    showScreen('screen-dashboard');
    render();
  });

  document.getElementById('fab-add').addEventListener('click', openAddScreen);

  document.getElementById('btn-view-all').addEventListener('click', () => {
    showScreen('screen-transactions');
    render();
  });
}

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
  _currentScreen = id;

  document.querySelectorAll('.nav-item[data-screen]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.screen === id);
  });

  const fab = document.getElementById('fab-add');
  if (fab) fab.style.display = (id === 'screen-add' || id === 'screen-cc') ? 'none' : 'flex';

  el?.querySelector('.screen-content')?.scrollTo(0, 0);
}

// ─────────────────────────────────────────
// INCOME MODAL
// Sets income for current month ONLY.
// Past summaries are not touched.
// ─────────────────────────────────────────
function setupIncomeModal() {
  try {
    const modal     = document.getElementById('income-modal');
    const inputEl   = document.getElementById('income-input');
    const btnOpen   = document.getElementById('btn-set-income');
    const btnCancel = document.getElementById('modal-cancel');
    const btnSave   = document.getElementById('modal-save');

    if (!modal || !inputEl) {
      console.warn('Income modal elements missing');
      return;
    }

    // Open modal
    if (btnOpen) {
      btnOpen.addEventListener('click', () => {
        inputEl.value = getIncome() || '';
        modal.style.display = 'flex';
        setTimeout(() => inputEl.focus(), 100);
      });
    }

    // Cancel
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        modal.style.display = 'none';
      });
    }

    // Click outside modal (SAFE)
    if (modal) {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) {
          modal.style.display = 'none';
        }
      });
    }

    // Save
    if (btnSave) {
      btnSave.addEventListener('click', () => {
        const v = parseFloat(inputEl.value);
        if (isNaN(v) || v < 0) return;

        setIncome(v);
        modal.style.display = 'none';

        render();
      });
    }

    // Enter key
    if (inputEl) {
      inputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && btnSave) {
          btnSave.click();
        }
      });
    }

  } catch (e) {
    console.error('setupIncomeModal crashed:', e);
  }
}

console.log("setupIncomeModal completed");
// ─────────────────────────────────────────
// DASHBOARD
// All figures computed from _expenses raw
// data + getIncome() for the current month.
// Never reads from summary objects.
// ─────────────────────────────────────────

function renderDashboard() {
  const cmk = currentMonthKey();

  // Current-month real transactions only
  const currentAll = _expenses.filter(e => monthKey(e.date) === cmk);
  const exps       = currentAll.filter(e => e.type === 'expense');
  const incs       = currentAll.filter(e => e.type === 'income');

  // Compute from raw data — no stored totals
  const totalExp = exps.reduce((s, e) => s + Number(e.amount), 0);
  const extraInc = incs.reduce((s, e) => s + Number(e.amount), 0);
  const totalInc = getIncome() + extraInc;   // base salary + explicit income entries
  const savings  = getSavingsForMonth(cmk);
  const balance  = totalInc - totalExp - savings;

  document.getElementById('dash-income').textContent  = fmtFull(totalInc);
  document.getElementById('dash-expense').textContent = fmtFull(totalExp);
  document.getElementById('dash-balance').textContent = fmtFull(Math.abs(balance));

  const savingsInput = document.getElementById('savings-input');

  if (savingsInput) {
    savingsInput.value = savings || '';

    savingsInput.oninput = (e) => {
      const val = Math.max(0, Number(e.target.value) || 0);
      setSavingsForMonth(cmk, val);

      // DO NOT call generic render
      renderDashboard();

      // If your app has global refresh:
      if (typeof renderAll === 'function') renderAll();
   };
}

  // Savings badge — guard division by zero

  document.getElementById('chart-month-label').textContent =
    new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  document.getElementById('chart-total').textContent = fmtFull(totalExp);

  renderBarChart(exps);
  renderCategoryBreakdown(exps);
  renderRecentTransactions(currentAll);
}

// ── Bar Chart (current-month expenses only) ──

function renderBarChart(expenseList) {
  const canvas = document.getElementById('spending-chart');
  if (!canvas) return;

  const now   = new Date();
  const today = now.getDate();

  // Aggregate by local day number
  const totals = {};
  expenseList.forEach(e => {
    const d = new Date(e.date).getDate();   // local day
    totals[d] = (totals[d] || 0) + Number(e.amount);
  });

  // Show up to 15 days ending today
  const startDay = Math.max(1, today - 14);
  const days     = [];
  for (let d = startDay; d <= today; d++) {
    days.push({ day: d, amount: totals[d] || 0 });
  }

  const maxAmt = Math.max(...days.map(d => d.amount), 500);
  const dpr    = window.devicePixelRatio || 1;
  const W      = canvas.parentElement.clientWidth || 320;
  const H      = 160;

  canvas.width        = W * dpr;
  canvas.height       = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const padL = 4, padR = 4, padT = 12, padB = 28;
  const cW   = W - padL - padR;
  const cH   = H - padT - padB;
  const n    = days.length;
  const slot = cW / n;
  const bW   = Math.max(4, slot * 0.55);

  // Grid lines
  for (let i = 0; i <= 3; i++) {
    const y = padT + (cH / 3) * i;
    ctx.strokeStyle = 'rgba(0,0,0,0.05)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padL, y); ctx.lineTo(W - padR, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Bars
  days.forEach((d, i) => {
    const x    = padL + slot * i + slot / 2 - bW / 2;
    const bH   = Math.max(3, (d.amount / maxAmt) * cH);
    const y    = padT + cH - bH;
    const r    = Math.min(5, bW / 2, bH / 2);
    const isTd = d.day === today;

    if (isTd) {
      const g = ctx.createLinearGradient(x, y, x, y + bH);
      g.addColorStop(0, '#7C3AED'); g.addColorStop(1, '#4F46E5');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = d.amount > 0 ? 'rgba(79,70,229,0.2)' : 'rgba(0,0,0,0.04)';
    }

    ctx.beginPath();
    ctx.moveTo(x + r,      y);
    ctx.lineTo(x + bW - r, y);
    ctx.arcTo(x + bW, y,     x + bW, y + r,  r);
    ctx.lineTo(x + bW, y + bH);
    ctx.lineTo(x,      y + bH);
    ctx.lineTo(x,      y + r);
    ctx.arcTo(x,      y,     x + r,  y,       r);
    ctx.closePath();
    ctx.fill();

    if (isTd && d.amount > 0) {
      ctx.fillStyle = '#4F46E5';
      ctx.beginPath();
      ctx.arc(x + bW / 2, y - 5, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle    = isTd ? '#4F46E5' : 'rgba(0,0,0,0.32)';
    ctx.font         = `${isTd ? 700 : 400} 10px -apple-system,sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(d.day, x + bW / 2, H - 4);
  });
}

// ── Category Breakdown ────────────────────

function renderCategoryBreakdown(expenseList) {
  const el = document.getElementById('category-breakdown');
  if (!el) return;

  // Computed entirely from raw transactions
  const totals = {};
  expenseList.forEach(e => {
    totals[e.category] = (totals[e.category] || 0) + Number(e.amount);
  });

  if (!Object.keys(totals).length) {
    el.innerHTML = '<p class="empty-state">No expenses this month yet. Tap + to add one.</p>';
    return;
  }

  const grand  = Object.values(totals).reduce((s, v) => s + v, 0);
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);

  el.innerHTML = sorted.map(([id, amount]) => {
    const cat = getCat(id);
    const pct = grand > 0 ? Math.round((amount / grand) * 100) : 0;
    return `<div class="category-row">
      <div class="cat-icon" style="background:${cat.color}18;color:${cat.color}">${cat.icon}</div>
      <div class="cat-info">
        <div class="cat-name">${cat.label}</div>
        <div class="cat-bar-wrap">
          <div class="cat-bar" style="width:${pct}%;background:${cat.color}"></div>
        </div>
      </div>
      <div class="cat-amount">${fmtFull(amount)}</div>
    </div>`;
  }).join('');
}

// ── Recent Transactions (dashboard preview) ──
// Placeholder is rendered from UI constants —
// there is no placeholder object in _expenses.

function renderRecentTransactions(currentAll) {
  const el = document.getElementById('recent-transactions');
  if (!el) return;

  if (!currentAll.length) {
    // Pure UI placeholder — no storage object, no calculations
    el.innerHTML = `<div class="txn-row is-placeholder">
      <div class="txn-icon" style="background:#EF444418;color:#EF4444">🍽️</div>
      <div class="txn-info">
        <div class="txn-title">Your first expense will show here</div>
        <div class="txn-time"><span class="placeholder-badge">Sample</span></div>
      </div>
      <div class="txn-amount expense">—</div>
    </div>`;
    return;
  }

  const recent = [...currentAll]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 5);

  el.innerHTML = recent.map(e => {
    const cat = getCat(e.category);
    return `<div class="txn-row">
      <div class="txn-icon" style="background:${cat.color}18;color:${cat.color}">${cat.icon}</div>
      <div class="txn-info">
        <div class="txn-title">${escHtml(e.note || cat.label)}</div>
        <div class="txn-time">${formatTime(e.date)}</div>
      </div>
      <div class="txn-amount ${e.type === 'income' ? 'income' : 'expense'}">
        ${e.type === 'income' ? '+' : '−'}${fmtFull(e.amount)}
      </div>
    </div>`;
  }).join('');
}

// ─────────────────────────────────────────
// TRANSACTIONS SCREEN
// ─────────────────────────────────────────

function renderTransactions() {
  const el = document.getElementById('transactions-list');
  if (!el) return;

  const cmk = currentMonthKey();

  const ml = document.getElementById('txn-month-label');
  if (ml) ml.textContent =
    new Date().toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });

  // Current-month entries, sorted newest first
  const real = _expenses
    .filter(e => monthKey(e.date) === cmk)
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  const cb = document.getElementById('txn-count-badge');
  if (cb) cb.textContent = plural(real.length, 'entry');

  if (!real.length) {
    // UI-only placeholder — not from storage
    el.innerHTML = `<div class="date-group">
      <div class="date-group-header">
        <span class="date-group-label">Today</span>
        <span class="date-group-total">Sample entry</span>
      </div>
      <div class="card txn-group-card">
        <div class="txn-row is-placeholder">
          <div class="txn-icon" style="background:#EF444418;color:#EF4444">🍽️</div>
          <div class="txn-info">
            <div class="txn-title">Your first expense will show here</div>
            <div class="txn-time">
              <span class="placeholder-badge">Sample — disappears on first entry</span>
            </div>
          </div>
          <div class="txn-amount expense">—</div>
        </div>
      </div>
    </div>`;
    return;
  }

  // Totals computed from raw data
  const totalExpense = real
    .filter(e => e.type === 'expense')
    .reduce((s, e) => s + Number(e.amount), 0);
  const totalIncome = real
    .filter(e => e.type === 'income')
    .reduce((s, e) => s + Number(e.amount), 0);

  let html = `<div class="card txn-summary-card pop-in">
    <div class="txn-summary-row">
      <span class="ts-label">Month Total</span>
      <span class="ts-amount">${fmtFull(totalExpense)}</span>
    </div>
    <div class="ts-count">
      ${plural(real.length, 'transaction')}${totalIncome > 0 ? ' · ' + fmtFull(totalIncome) + ' income' : ''}
    </div>
  </div>`;

  // Group by local date
  const groups = {};
  real.forEach(e => {
    const dk = dateOnly(e.date);
    (groups[dk] = groups[dk] || []).push(e);
  });

  // Descending date order
  const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  sortedKeys.forEach(dk => {
    const txns     = groups[dk];
    const dayTotal = txns
      .filter(e => e.type === 'expense')
      .reduce((s, e) => s + Number(e.amount), 0);

    html += `<div class="date-group">
      <div class="date-group-header">
        <span class="date-group-label">${formatDateGroupLabel(dk)}</span>
        <span class="date-group-total">${plural(txns.length, 'entry')} · ${fmtFull(dayTotal)}</span>
      </div>
      <div class="card txn-group-card">
        ${txns.map((e, i) => {
          const cat = getCat(e.category);
          return `<div class="txn-row${i < txns.length - 1 ? ' txn-row-border' : ''}">
            <div class="txn-icon" style="background:${cat.color}18;color:${cat.color}">${cat.icon}</div>
            <div class="txn-info">
              <div class="txn-title">${escHtml(e.note || cat.label)}</div>
              <div class="txn-time">${formatTime(e.date)}</div>
            </div>
            <div class="txn-right">
              <div class="txn-amount ${e.type === 'income' ? 'income' : 'expense'}">
                ${e.type === 'income' ? '+' : '−'}${fmtFull(e.amount)}
              </div>
              <button class="delete-btn" data-id="${e.id}" aria-label="Delete">×</button>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  });

  el.innerHTML = html;

  el.querySelectorAll('.delete-btn[data-id]').forEach(btn => {
    btn.addEventListener('click', () => deleteEntry(btn.dataset.id));
  });
}

// ── Delete ────────────────────────────────

function deleteEntry(id) {
  // Animate out, then mutate + persist + re-render
  const row = document.querySelector(`.delete-btn[data-id="${id}"]`)?.closest('.txn-row');
  if (row) {
    row.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
    row.style.opacity    = '0';
    row.style.transform  = 'translateX(24px)';
  }

  setTimeout(() => {
    // String comparison handles both numeric and legacy string IDs
    _expenses = _expenses.filter(e => String(e.id) !== String(id));
    saveExpenses();
    render();
  }, 210);
}

// ─────────────────────────────────────────
// ADD EXPENSE SCREEN
// ─────────────────────────────────────────

function setupAddForm() {
  renderCategoryPicker();

  document.getElementById('type-toggle').addEventListener('click', e => {
    const btn = e.target.closest('.type-btn');
    if (!btn) return;
    _selectedType = btn.dataset.type;
    updateTypeUI();
  });

  document.getElementById('btn-save-expense').addEventListener('click', handleSave);
}

function openAddScreen() {
  _selectedCat  = 'food';
  _selectedType = 'expense';
  document.getElementById('input-amount').value = '';
  document.getElementById('input-note').value   = '';
  document.getElementById('input-date').value   = todayStr();
  renderCategoryPicker();
  updateTypeUI();
  showScreen('screen-add');
  setTimeout(() => document.getElementById('input-amount').focus(), 150);
}

function renderCategoryPicker() {
  const el = document.getElementById('category-picker');
  if (!el) return;
  el.innerHTML = CATEGORIES.map(cat => {
    const active = cat.id === _selectedCat;
    const style  = active
      ? `background:${cat.color}18;border-color:${cat.color};color:${cat.color};`
      : '';
    return `<button class="cat-pick-btn${active ? ' active' : ''}"
        data-cat="${cat.id}" style="${style}" aria-label="${cat.label}">
      <span>${cat.icon}</span>
      <span class="cat-pick-label">${cat.label}</span>
    </button>`;
  }).join('');

  el.querySelectorAll('.cat-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _selectedCat = btn.dataset.cat;
      renderCategoryPicker();
    });
  });
}

function updateTypeUI() {
  document.querySelectorAll('#type-toggle .type-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.type === _selectedType);
  });
  const saveBtn = document.getElementById('btn-save-expense');
  const saveTxt = document.getElementById('save-btn-text');
  if (_selectedType === 'income') {
    saveBtn.classList.add('income-mode');
    saveTxt.textContent = 'Save Income';
  } else {
    saveBtn.classList.remove('income-mode');
    saveTxt.textContent = 'Save Expense';
  }
}

function handleSave() {
  const amountEl = document.getElementById('input-amount');
  const noteEl   = document.getElementById('input-note');
  const dateEl   = document.getElementById('input-date');

  // Validate amount
  const amount = parseFloat(amountEl.value);
  if (!isFinite(amount) || amount <= 0) {
    amountEl.classList.add('shake');
    setTimeout(() => amountEl.classList.remove('shake'), 400);
    amountEl.focus();
    return;
  }

  // Validate date
  if (!dateEl.value) {
    dateEl.classList.add('shake');
    setTimeout(() => dateEl.classList.remove('shake'), 400);
    return;
  }

  // Build entry — strict schema, guaranteed unique ID
  const entry = {
    id:       generateId(),
    amount:   Math.round(amount * 100) / 100,
    category: _selectedCat,
    note:     noteEl.value.trim(),
    date:     buildISOTimestamp(dateEl.value),
    type:     _selectedType,
  };

  // Append (never overwrite), persist immediately
  _expenses.push(entry);
  saveExpenses();

  // Ensure the current month has an income value seeded
  seedIncomeForMonth(currentMonthKey(), DEFAULT_INCOME);

  const saveBtn = document.getElementById('btn-save-expense');
  const saveTxt = document.getElementById('save-btn-text');
  saveBtn.classList.add('success');
  saveTxt.textContent = '✓ Saved!';

  setTimeout(() => {
    saveBtn.classList.remove('success');
    updateTypeUI();
    showScreen('screen-dashboard');
    render();
  }, 700);
}

// ─────────────────────────────────────────
// MONTHLY SUMMARY SCREEN
//
// Reads only from _summaries — never from
// _expenses or live calculations. Summaries
// are frozen snapshots; their values never
// change after creation.
// ─────────────────────────────────────────

function renderSummary() {
  const listEl  = document.getElementById('monthly-summary-list');
  const emptyEl = document.getElementById('summary-empty');
  if (!listEl) return;

  const sorted = [..._summaries].sort((a, b) => b.monthKey.localeCompare(a.monthKey));

  if (!sorted.length) {
    emptyEl.style.display = 'flex';
    listEl.innerHTML      = '';
    return;
  }
  emptyEl.style.display = 'none';

  // Total savings: sum of frozen savings values from all past summaries
  const totalSavings = sorted.reduce((s, m) => s + Number(m.savings), 0);
  const pillEl       = document.getElementById('total-savings-pill');
  if (pillEl) {
    pillEl.textContent   = (totalSavings >= 0 ? '↑ ' : '↓ ') + fmtFull(Math.abs(totalSavings)) + ' total';
    pillEl.style.display = 'block';
  }

  listEl.innerHTML = sorted.map(m => {
    const savings = Number(m.savings);
    const expense = Number(m.expense);
    const cats    = Object.entries(m.categories || {})
      .map(([id, v]) => [id, Number(v) || 0])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    return `<div class="card">
      <div class="summary-month-header">
        <h3 class="summary-month-name">${monthDisplayName(m.monthKey)}</h3>
        <div class="summary-savings ${savings >= 0 ? 'positive' : 'negative'}">
          ${savings >= 0 ? '↑' : '↓'} ${fmtFull(Math.abs(savings))}
        </div>
      </div>
      <div class="summary-totals">
        <div class="summary-total-item">
          <span class="st-label">Expense</span>
          <span class="st-amount expense">${fmtFull(expense)}</span>
        </div>
        <div class="summary-total-divider"></div>
        <div class="summary-total-item">
          <span class="st-label">${savings >= 0 ? 'Saved' : 'Deficit'}</span>
          <span class="st-amount ${savings >= 0 ? 'income' : 'expense'}">${fmtFull(Math.abs(savings))}</span>
        </div>
      </div>
      ${cats.length ? `<div class="summary-cats">
        ${cats.map(([id, amt]) => {
          const cat = getCat(id);
          return `<div class="summary-cat-row">
            <span class="summary-cat-icon">${cat.icon}</span>
            <span class="summary-cat-name">${cat.label}</span>
            <span class="summary-cat-amount">${fmtFull(amt)}</span>
          </div>`;
        }).join('')}
      </div>` : ''}
      <button
        class="export-report-btn"
        data-mk="${m.monthKey}"
        style="
          width:100%;margin-top:14px;padding:10px 14px;
          border:1.5px solid rgba(79,70,229,0.2);border-radius:10px;
          background:rgba(79,70,229,0.04);color:#4F46E5;
          font-size:13px;font-weight:600;cursor:pointer;
          display:flex;align-items:center;justify-content:center;gap:7px;
          transition:background 0.15s ease;
        "
      >⬇️ Download Report</button>
    </div>`;
  }).join('');

  // Attach export click + hover handlers after innerHTML is set
  listEl.querySelectorAll('.export-report-btn').forEach(btn => {
    btn.addEventListener('click',      () => exportMonthReport(btn.dataset.mk));
    btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(79,70,229,0.10)'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(79,70,229,0.04)'; });
    btn.addEventListener('mousedown',  () => { btn.style.transform  = 'scale(0.97)'; });
    btn.addEventListener('mouseup',    () => { btn.style.transform  = 'scale(1)'; });
  });
}

// ─────────────────────────────────────────
// CREDIT CARD SCREEN
// Completely independent from _expenses.
// No CC data leaks into expense calculations.
// ─────────────────────────────────────────

function setupCCScreen() {
  // ── Limit modal ──
  const limitModal = document.getElementById('cc-limit-modal');
  const limitInput = document.getElementById('cc-limit-input');

  document.getElementById('btn-edit-limit').addEventListener('click', () => {
    limitInput.value         = _ccData.limit || '';
    limitModal.style.display = 'flex';
    setTimeout(() => limitInput.focus(), 100);
  });
  document.getElementById('cc-limit-cancel').addEventListener('click', () => {
    limitModal.style.display = 'none';
  });
  limitModal.addEventListener('click', e => {
    if (e.target === limitModal) limitModal.style.display = 'none';
  });
  document.getElementById('cc-limit-save').addEventListener('click', () => {
    const v = parseFloat(limitInput.value);
    if (isNaN(v) || v < 0) return;
    _ccData.limit            = v;
    saveCC();
    limitModal.style.display = 'none';
    render();
  });
  limitInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('cc-limit-save').click();
  });

  // ── Add CC expense modal ──
  const addModal = document.getElementById('cc-add-modal');
  document.getElementById('btn-add-cc-expense').addEventListener('click', openCCAddModal);
  document.getElementById('cc-add-close').addEventListener('click', () => {
    addModal.style.display = 'none';
  });
  addModal.addEventListener('click', e => {
    if (e.target === addModal) addModal.style.display = 'none';
  });
  document.getElementById('btn-save-cc').addEventListener('click', handleSaveCC);

  renderCCCategoryPicker();
}

function openCCAddModal() {
  _ccSelectedCat = 'shopping';
  document.getElementById('cc-amount-input').value = '';
  document.getElementById('cc-note-input').value   = '';
  document.getElementById('cc-date-input').value   = todayStr();
  renderCCCategoryPicker();
  document.getElementById('cc-add-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('cc-amount-input').focus(), 100);
}

function renderCCCategoryPicker() {
  const el = document.getElementById('cc-category-picker');
  if (!el) return;
  el.innerHTML = CATEGORIES.map(cat => {
    const active = cat.id === _ccSelectedCat;
    const style  = active
      ? `background:${cat.color}18;border-color:${cat.color};color:${cat.color};`
      : '';
    return `<button class="cat-pick-btn${active ? ' active' : ''}"
        data-cat="${cat.id}" style="${style}" aria-label="${cat.label}">
      <span>${cat.icon}</span>
      <span class="cat-pick-label">${cat.label}</span>
    </button>`;
  }).join('');
  el.querySelectorAll('.cat-pick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _ccSelectedCat = btn.dataset.cat;
      renderCCCategoryPicker();
    });
  });
}

function handleSaveCC() {
  const amountEl = document.getElementById('cc-amount-input');
  const noteEl   = document.getElementById('cc-note-input');
  const dateEl   = document.getElementById('cc-date-input');

  const amount = parseFloat(amountEl.value);
  if (!isFinite(amount) || amount <= 0) {
    amountEl.classList.add('shake');
    setTimeout(() => amountEl.classList.remove('shake'), 400);
    amountEl.focus();
    return;
  }
  if (!dateEl.value) {
    dateEl.classList.add('shake');
    setTimeout(() => dateEl.classList.remove('shake'), 400);
    return;
  }

  const entry = {
    id:       generateId(),
    amount:   Math.round(amount * 100) / 100,
    category: _ccSelectedCat,
    note:     noteEl.value.trim(),
    date:     buildISOTimestamp(dateEl.value),
  };

  _ccData.transactions.push(entry);
  saveCC();
  document.getElementById('cc-add-modal').style.display = 'none';
  render();
}

function renderCCScreen() {
  // Computed from raw CC transactions only — no _expenses involvement
  const txns  = [...(_ccData.transactions || [])]
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const used  = txns.reduce((s, e) => s + Number(e.amount), 0);
  const limit = Number(_ccData.limit) || 0;
  const avail = Math.max(0, limit - used);
  const pct   = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;

  document.getElementById('cc-used-amount').textContent   = fmtFull(used);
  document.getElementById('cc-limit-display').textContent = limit > 0 ? fmtFull(limit) : 'Tap ✏️ to set';
  document.getElementById('cc-avail-display').textContent = limit > 0 ? fmtFull(avail) : '—';

  const pctEl  = document.getElementById('cc-util-pct');
  const barEl  = document.getElementById('cc-util-bar');
  const hintEl = document.getElementById('cc-util-hint');

  pctEl.textContent = limit > 0 ? pct.toFixed(1) + '%' : '—';
  barEl.style.width = pct + '%';
  barEl.className   = 'cc-util-bar' + (pct >= 75 ? ' danger' : pct >= 30 ? ' warn' : '');

  if (limit > 0) {
    hintEl.textContent = pct >= 75
      ? '⚠️ High utilization — consider paying down your balance'
      : pct >= 30
        ? '📊 Moderate utilization — you\'re doing okay'
        : '✅ Great! Low utilization is good for your credit score';
  } else {
    hintEl.textContent = 'Set your credit limit using the ✏️ button above';
  }

  const countEl = document.getElementById('cc-txn-count');
  if (countEl) countEl.textContent = plural(txns.length, 'entry');

  const listEl = document.getElementById('cc-transactions-list');
  if (!listEl) return;

  if (!txns.length) {
    listEl.innerHTML = '<p class="empty-state">No CC transactions yet. Tap "Add CC Expense" above.</p>';
    return;
  }

  // Group by local date
  const groups = {};
  txns.forEach(e => {
    const dk = dateOnly(e.date);
    (groups[dk] = groups[dk] || []).push(e);
  });

  const sortedKeys = Object.keys(groups).sort((a, b) => b.localeCompare(a));

  listEl.innerHTML = sortedKeys.map(dk => {
    const dayTxns  = groups[dk];
    const dayTotal = dayTxns.reduce((s, e) => s + Number(e.amount), 0);
    return `<div style="margin-bottom:8px">
      <div class="date-group-header" style="padding:6px 2px 4px">
        <span class="date-group-label">${formatDateGroupLabel(dk)}</span>
        <span class="date-group-total">${fmtFull(dayTotal)}</span>
      </div>
      ${dayTxns.map((e, i) => {
        const cat = getCat(e.category);
        return `<div class="txn-row${i < dayTxns.length - 1 ? ' txn-row-border' : ''}">
          <div class="txn-icon" style="background:${cat.color}18;color:${cat.color}">${cat.icon}</div>
          <div class="txn-info">
            <div class="txn-title">${escHtml(e.note || cat.label)}</div>
            <div class="txn-time">${formatTime(e.date)}</div>
          </div>
          <div class="txn-right">
            <div class="txn-amount expense">−${fmtFull(e.amount)}</div>
            <button class="delete-btn" data-ccid="${e.id}" aria-label="Delete">×</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  }).join('');

  listEl.querySelectorAll('.delete-btn[data-ccid]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id  = btn.dataset.ccid;
      const row = btn.closest('.txn-row');
      if (row) {
        row.style.transition = 'opacity 0.2s ease, transform 0.2s ease';
        row.style.opacity    = '0';
        row.style.transform  = 'translateX(24px)';
      }
      setTimeout(() => {
        _ccData.transactions = _ccData.transactions.filter(
          e => String(e.id) !== String(id)
        );
        saveCC();
        render();
      }, 210);
    });
  });
}

// ─────────────────────────────────────────
// RESIZE — redraw chart only
// ─────────────────────────────────────────

// ───── REPORT EXPORT FEATURE ─────────────
// Generates a PDF report + JSON backup for
// any past month.  All data sourced from the
// frozen _summaries snapshot + the archived
// transaction list stored during transition.
// No in-memory state is mutated here.
// ─────────────────────────────────────────

/**
 * Entry point — called by the "Download Report"
 * button inside each summary card.
 */
function exportMonthReport(mk) {
  const m = _summaries.find(s => s.monthKey === mk);
  if (!m) return;

  const transactions = getArchivedTransactions(mk);

  // Build the file base-name: e.g. "March-2026"
  const [yr, mo] = mk.split('-');
  const mName    = new Date(+yr, +mo - 1, 1)
    .toLocaleDateString('en-US', { month: 'long' });
  const fileBase = `${mName}-${yr}`;

  _exportPDF(m, transactions, `${fileBase}-report.pdf`);
  _exportJSON(m, transactions, `${fileBase}-backup.json`);
}

// ── File download helper ──────────────────

function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 200);
}

// ── JSON backup ───────────────────────────

function _exportJSON(m, transactions, filename) {
  const payload = {
    month:      m.monthKey,
    income:     Number(m.income)  || 0,
    expense:    Number(m.expense) || 0,
    savings:    Number(m.savings) || 0,
    categories: Object.fromEntries(
      Object.entries(m.categories || {})
        .map(([k, v]) => [k, Number(v) || 0])
    ),
    // Expose only public fields — no internal IDs
    transactions: transactions.map(e => ({
      amount:   Number(e.amount) || 0,
      category: String(e.category || 'other'),
      note:     String(e.note || ''),
      date:     String(e.date),
      type:     e.type === 'income' ? 'income' : 'expense',
    })),
  };

  const blob = new Blob(
    [JSON.stringify(payload, null, 2)],
    { type: 'application/json' }
  );
  _triggerDownload(blob, filename);
}

// ── PDF report ────────────────────────────
// Uses jsPDF (loaded via CDN in index.html).
// Note: jsPDF's built-in Helvetica font does
// not contain the ₹ glyph, so "Rs." is used
// in PDF output while ₹ is kept in the app UI.

function _exportPDF(m, transactions, filename) {
  if (!window.jspdf || !window.jspdf.jsPDF) {
    alert('PDF library is still loading — please try again in a moment.');
    return;
  }

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // ── Layout constants ────────────────────
  const PW   = 210;
  const PH   = doc.internal.pageSize.getHeight();
  const LPAD = 18;
  const RPAD = 18;
  const CW   = PW - LPAD - RPAD;
  let   y    = 0;

  // ── Colour palette (RGB arrays) ─────────
  const C_INK1    = [15,  17,  39 ];
  const C_INK2    = [75,  85,  99 ];
  const C_INK3    = [156, 163, 175];
  const C_PRIMARY = [79,  70,  229];
  const C_GREEN   = [5,   150, 105];
  const C_RED     = [220, 38,  38 ];
  const C_BG      = [248, 249, 255];

  // ── Helpers ─────────────────────────────
  function clr(rgb)  { doc.setTextColor(rgb[0], rgb[1], rgb[2]); }
  function fill(rgb) { doc.setFillColor(rgb[0], rgb[1], rgb[2]); }
  function ln(mm)    { y += mm; }
  function rupees(v) {
    return 'Rs.' + Math.abs(Math.round(Number(v) || 0)).toLocaleString('en-IN');
  }
  function ensureSpace(need) {
    if (y + need > PH - 16) { doc.addPage(); y = 22; }
  }

  // ─────────────────────────────────────────
  // HEADER BAND
  // ─────────────────────────────────────────
  fill(C_PRIMARY);
  doc.rect(0, 0, PW, 46, 'F');

  // Subtle diagonal stripe decoration
  doc.setDrawColor(255, 255, 255);
  doc.setLineWidth(0.4);
  try {
    doc.setGState(new doc.GState({ opacity: 0.07 }));
    for (let i = 0; i < 9; i++) {
      doc.line(PW - 55 + i * 11, 0, PW - 55 + i * 11 + 46, 46);
    }
    doc.setGState(new doc.GState({ opacity: 1.0 }));
  } catch (_) { /* GState not supported in all jsPDF builds — skip decoration */ }

  doc.setFontSize(20);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text('FinTrack', LPAD, 17);

  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(195, 202, 255);
  doc.text('Personal Finance Report', LPAD, 26);

  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(255, 255, 255);
  doc.text(monthDisplayName(m.monthKey), LPAD, 38);

  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(195, 202, 255);
  doc.text('Generated ' + localDateStr(new Date()), PW - RPAD, 38, { align: 'right' });

  y = 56;

  // ─────────────────────────────────────────
  // FINANCIAL SUMMARY — 3 stat boxes
  // ─────────────────────────────────────────
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  clr(C_INK3);
  doc.text('FINANCIAL SUMMARY', LPAD, y);
  ln(5);

  const boxW  = (CW - 6) / 3;
  const boxes = [
    { label: 'Income',  value: m.income,  color: C_GREEN },
    { label: 'Expense', value: m.expense, color: C_RED   },
    { label: 'Savings', value: m.savings, color: Number(m.savings) >= 0 ? C_GREEN : C_RED },
  ];

  boxes.forEach((b, i) => {
    const bx = LPAD + i * (boxW + 3);
    fill(C_BG);
    doc.roundedRect(bx, y, boxW, 24, 2.5, 2.5, 'F');

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    clr(C_INK3);
    doc.text(b.label.toUpperCase(), bx + 5, y + 8);

    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(b.color[0], b.color[1], b.color[2]);
    doc.text(rupees(b.value), bx + 5, y + 19);
  });

  ln(32);

  // ─────────────────────────────────────────
  // CATEGORY BREAKDOWN
  // ─────────────────────────────────────────
  const cats = Object.entries(m.categories || {})
    .map(([id, v]) => [id, Number(v) || 0])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);

  if (cats.length) {
    ensureSpace(cats.length * 12 + 20);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    clr(C_INK3);
    doc.text('CATEGORY BREAKDOWN', LPAD, y);
    ln(6);

    const totalCatExp = cats.reduce((s, [, v]) => s + v, 0);
    const maxBarW     = CW - 62;

    cats.forEach(([id, amt], idx) => {
      ensureSpace(13);
      const cat     = getCat(id);
      const pct     = totalCatExp > 0 ? Math.round((amt / totalCatExp) * 100) : 0;
      const barFill = totalCatExp > 0 ? Math.max(2, (amt / totalCatExp) * maxBarW) : 0;

      if (idx % 2 === 0) {
        fill(C_BG);
        doc.rect(LPAD, y - 1, CW, 10, 'F');
      }

      // Label
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      clr(C_INK1);
      doc.text(cat.label, LPAD + 3, y + 6);

      // Bar track
      const barX = LPAD + 42;
      doc.setFillColor(220, 224, 240);
      doc.roundedRect(barX, y + 2.5, maxBarW, 4, 1, 1, 'F');

      // Bar fill
      fill(C_PRIMARY);
      if (barFill > 0) doc.roundedRect(barX, y + 2.5, barFill, 4, 1, 1, 'F');

      // Percent
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      clr(C_INK3);
      doc.text(pct + '%', barX + maxBarW + 3, y + 6);

      // Amount
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      clr(C_INK1);
      doc.text(rupees(amt), PW - RPAD - 2, y + 6, { align: 'right' });

      ln(11);
    });

    ln(5);
  }

  // ─────────────────────────────────────────
  // TOP 5 TRANSACTIONS (by expense amount)
  // ─────────────────────────────────────────
  const topTxns = [...transactions]
    .filter(e => e.type !== 'income')
    .sort((a, b) => Number(b.amount) - Number(a.amount))
    .slice(0, 5);

  if (topTxns.length) {
    ensureSpace(topTxns.length * 11 + 28);

    doc.setFontSize(8);
    doc.setFont('helvetica', 'bold');
    clr(C_INK3);
    doc.text('TOP TRANSACTIONS', LPAD, y);
    ln(5);

    // Table header
    fill(C_PRIMARY);
    doc.rect(LPAD, y, CW, 8, 'F');
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(255, 255, 255);
    doc.text('Description', LPAD + 3,      y + 5.5);
    doc.text('Category',    LPAD + 74,     y + 5.5);
    doc.text('Date',        LPAD + 116,    y + 5.5);
    doc.text('Amount',      PW - RPAD - 2, y + 5.5, { align: 'right' });
    ln(10);

    topTxns.forEach((e, idx) => {
      ensureSpace(11);
      if (idx % 2 === 0) {
        fill(C_BG);
        doc.rect(LPAD, y - 1, CW, 10, 'F');
      }
      const cat  = getCat(e.category);
      const desc = String(e.note || cat.label).substring(0, 32);
      const date = localDateStr(new Date(e.date));

      doc.setFontSize(8.5);
      doc.setFont('helvetica', 'normal');
      clr(C_INK1);
      doc.text(desc, LPAD + 3, y + 6);
      clr(C_INK2);
      doc.text(cat.label, LPAD + 74,  y + 6);
      doc.text(date,      LPAD + 116, y + 6);
      doc.setFont('helvetica', 'bold');
      clr(C_RED);
      doc.text(rupees(e.amount), PW - RPAD - 2, y + 6, { align: 'right' });
      ln(10);
    });
  }

  // ─────────────────────────────────────────
  // FOOTER on every page
  // ─────────────────────────────────────────
  const totalPages = doc.internal.getNumberOfPages();
  for (let p = 1; p <= totalPages; p++) {
    doc.setPage(p);
    doc.setDrawColor(C_INK3[0], C_INK3[1], C_INK3[2]);
    doc.setLineWidth(0.3);
    doc.line(LPAD, PH - 12, PW - RPAD, PH - 12);
    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    clr(C_INK3);
    doc.text(
      `FinTrack  \u00b7  ${monthDisplayName(m.monthKey)} Report  \u00b7  Page ${p} of ${totalPages}`,
      PW / 2, PH - 7, { align: 'center' }
    );
  }

  // jsPDF .save() triggers the browser download directly
  doc.save(filename);
}

// ───── END REPORT EXPORT FEATURE ──────────

window.addEventListener('resize', () => {
  if (_currentScreen === 'screen-dashboard') {
    const cmk  = currentMonthKey();
    const exps = _expenses.filter(
      e => e.type === 'expense' && monthKey(e.date) === cmk
    );
    renderBarChart(exps);
  }
});
