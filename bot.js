// Polymarket Top Trader Tracker — Telegram Bot
// Run with: node bot.js

const BASE = "https://data-api.polymarket.com";
const POLYMARKET_URL = "https://polymarket.com/event";

const TELEGRAM_TOKEN  = process.env.TELEGRAM_TOKEN  || "";
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT   || "";
const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL || "120") * 1000;
const PERIOD          = process.env.LEADERBOARD_PERIOD || "ALL";
const MIN_SIZE        = parseFloat(process.env.MIN_TRADE_SIZE || "0.50");

// swisstony is always tracked — active trader with strong history
const FIXED_WALLET = {
  wallet: "0x204f72f35326db932158cba6adff0b9a1da95e14",
  name:   "swisstony",
  rank:   1,
  pnl:    0,
  fixed:  true,
};

const seenTx = new Set();
let trackedWallets = [];
let lastLeaderboardRefresh = 0;
const LEADERBOARD_TTL = 3600 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtMoney(n) {
  n = parseFloat(n || 0);
  const sign = n >= 0 ? "+" : "-";
  const abs = Math.abs(n);
  if (abs >= 1e6) return `${sign}$${(abs/1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs/1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(2)}`;
}

function fmtSize(n) {
  n = parseFloat(n || 0);
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function rankEmoji(r) { return ["🥇","🥈","🥉"][r-1] || `#${r}`; }

function fmtTime(ts) {
  const d = new Date(ts * 1000);
  return d.toUTCString().replace(" GMT", " UTC").slice(5, 22);
}

function nowStr() { return new Date().toISOString().slice(11,19); }

// ── Fetch helpers (no dependencies, uses built-in fetch) ──────────────────────
async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
  return res.json();
}

async function fetchLeaderboard() {
  return get(`${BASE}/v1/leaderboard?limit=3&orderBy=PNL&timePeriod=${PERIOD}`);
}

async function fetchTrades(wallet) {
  const data = await get(`${BASE}/trades?user=${wallet}&limit=20&takerOnly=false`);
  return Array.isArray(data) ? data : [];
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) {
    console.log("\n── ALERT (no Telegram configured) ──");
    console.log(text.replace(/<[^>]+>/g, ""));
    return;
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) console.error(`[${nowStr()}] Telegram error: ${res.status}`);
}

function buildAlert(trade, trader) {
  const side     = (trade.side || "").toUpperCase();
  const emoji    = side === "BUY" ? "🟢" : "🔴";
  const size     = parseFloat(trade.size || 0);
  const price    = parseFloat(trade.price || 0);
  const title    = trade.title || trade.slug || "Unknown market";
  const outcome  = trade.outcome || "—";
  const slug     = trade.eventSlug || trade.slug || "";
  const link     = slug ? `${POLYMARKET_URL}/${slug}` : "https://polymarket.com";
  const ts       = trade.timestamp ? fmtTime(trade.timestamp) : "just now";

  return [
    `${emoji} <b>${side}</b>  ·  ${rankEmoji(trader.rank)} <b>${trader.name}</b>`,
    ``,
    `📋 <b>${title}</b>`,
    ``,
    `  Outcome:    <b>${outcome}</b>`,
    `  Price:      <b>${(price * 100).toFixed(1)}¢</b>`,
    `  Size:       <b>${fmtSize(size)}</b>`,
    `  Trader P&L: <b>${fmtMoney(trader.pnl)}</b> (all-time)`,
    ``,
    `🕐 ${ts}`,
    ``,
    `<a href="${link}">▶️ Open on Polymarket to mirror</a>`,
  ].join("\n");
}

async function sendStartup() {
  const lines = [
    `<b>📡 PolyTrack Bot started</b>`,
    ``,
    `Min trade size: <b>${fmtSize(MIN_SIZE)}</b>`,
    ``,
    `📌 <b>Fixed (All-Time)</b>`,
  ];
  for (const w of trackedWallets.filter(w => w.fixed)) {
    lines.push(`${rankEmoji(w.rank)} <b>${w.name}</b>  ${fmtMoney(w.pnl)}`);
    lines.push(`   <code>${w.wallet}</code>`);
  }
  lines.push(``, `📈 <b>Weekly Top 2</b>`);
  for (const w of trackedWallets.filter(w => !w.fixed)) {
    lines.push(`${rankEmoji(w.rank)} <b>${w.name}</b>  ${fmtMoney(w.pnl)} this week`);
    lines.push(`   <code>${w.wallet}</code>`);
  }
  lines.push(``, `Alerts will fire here when they trade.`);
  await sendTelegram(lines.join("\n"));
}

// ── Core ──────────────────────────────────────────────────────────────────────
async function refreshLeaderboard() {
  console.log(`[${nowStr()}] Refreshing leaderboard…`);

  // Always include swisstony — update his current PnL
  try {
    const alltime = await get(`${BASE}/v1/leaderboard?limit=10&orderBy=PNL&timePeriod=ALL`);
    const sw = alltime.find(t => t.proxyWallet === FIXED_WALLET.wallet);
    if (sw) FIXED_WALLET.pnl = parseFloat(sw.pnl || 0);
  } catch(e) {}

  // Get top 2 from weekly leaderboard, excluding swisstony
  const weekly = await get(`${BASE}/v1/leaderboard?limit=10&orderBy=PNL&timePeriod=WEEK`);
  const top2weekly = weekly
    .filter(t => t.proxyWallet !== FIXED_WALLET.wallet)
    .slice(0, 2)
    .map((t, i) => ({
      rank:   i + 2,
      name:   t.userName || t.proxyWallet?.slice(0, 8) + "…",
      wallet: t.proxyWallet || "",
      pnl:    parseFloat(t.pnl || 0),
      weekly: true,
    }));

  trackedWallets = [FIXED_WALLET, ...top2weekly];

  for (const w of trackedWallets) {
    const tag = w.fixed ? "ALL-TIME" : "WEEKLY";
    console.log(`  ${rankEmoji(w.rank)} ${w.name}  ${fmtMoney(w.pnl)}  [${tag}]`);
  }
  lastLeaderboardRefresh = Date.now();
}

async function seedSeen() {
  console.log(`[${nowStr()}] Seeding trade history (won't replay old trades)…`);
  for (const trader of trackedWallets) {
    if (!trader.wallet) continue;
    try {
      const trades = await get(`${BASE}/trades?user=${trader.wallet}&limit=100&takerOnly=false`);
      (Array.isArray(trades) ? trades : []).forEach(t => { if (t.transactionHash) seenTx.add(t.transactionHash); });
      console.log(`  Seeded ${trades.length || 0} trades for ${trader.name}`);
    } catch (e) {
      console.error(`  Seed failed for ${trader.name}: ${e.message}`);
    }
  }
}

async function fetchWinLoss(trader) {
  try {
    let positions = [];

    // Try redeemed positions first
    try {
      const d = await get(`${BASE}/positions?user=${trader.wallet}&limit=500&redeemed=true`);
      positions = Array.isArray(d) ? d : (d.positions || d.data || []);
    } catch(e) {}

    // Fallback: get all positions and filter resolved ones client-side
    if (positions.length === 0) {
      try {
        const d = await get(`${BASE}/positions?user=${trader.wallet}&limit=500`);
        const all = Array.isArray(d) ? d : (d.positions || d.data || []);
        positions = all.filter(p => {
          const redeemed = p.redeemed === true || p.redeemed === 1;
          const resolved = parseFloat(p.currentValue ?? p.currentPrice ?? -1);
          const zeroed   = parseFloat(p.size ?? 1) === 0;
          return redeemed || resolved === 0 || resolved >= 0.99 || zeroed;
        });
      } catch(e) {}
    }

    // Last resort: use trades endpoint and derive from cashPnl field
    if (positions.length === 0) {
      const d = await get(`${BASE}/trades?user=${trader.wallet}&limit=500&takerOnly=false`);
      const trades = Array.isArray(d) ? d : [];
      // Group by conditionId to get per-market result
      const markets = {};
      for (const t of trades) {
        const id = t.conditionId;
        if (!id) continue;
        if (!markets[id]) markets[id] = { pnl: 0, size: 0 };
        const pnl  = parseFloat(t.cashPnl ?? 0);
        const size = parseFloat(t.size ?? 0);
        markets[id].pnl  += pnl;
        markets[id].size += size;
      }
      positions = Object.values(markets).filter(m => m.pnl !== 0);
    }

    let wins = 0, losses = 0, totalPnl = 0, halfDollarPnl = 0;

    for (const p of positions) {
      const pnl  = parseFloat(p.cashPnl ?? p.pnl ?? 0);
      const size = parseFloat(p.size ?? p.initialValue ?? 1);
      totalPnl += pnl;

      // Scale to $0.50: if they risked $size and made $pnl, $0.50 would make pnl*(0.50/size)
      if (size > 0) halfDollarPnl += pnl * (0.50 / size);

      if (pnl > 0) wins++;
      else if (pnl < 0) losses++;
    }

    const total   = wins + losses;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

    return { wins, losses, total, winRate, totalPnl, halfDollarPnl, tracked: positions.length };
  } catch (e) {
    return null;
  }
}

async function sendWinLossReport() {
  const lines = [`<b>📊 Win/Loss Report</b>`, `<i>Settled markets only</i>`, ``];

  for (const trader of trackedWallets) {
    const r = await fetchWinLoss(trader);
    if (!r || r.total === 0) {
      lines.push(`${rankEmoji(trader.rank)} <b>${trader.name}</b> — no settled data yet`);
      lines.push(``);
      continue;
    }

    const sign = r.halfDollarPnl >= 0 ? "+" : "";
    const pnlSign = r.totalPnl >= 0 ? "+" : "";

    lines.push(`${rankEmoji(trader.rank)} <b>${trader.name}</b>`);
    lines.push(`  Trades tracked:       <b>${r.tracked}</b>`);
    lines.push(`  Resolved:             <b>${r.total}</b>`);
    lines.push(`  Won: <b>${r.wins}</b>  ·  Lost: <b>${r.losses}</b>`);
    lines.push(`  Win rate:             <b>${r.winRate}%</b>`);
    lines.push(`  Your P&L ($0.50/trade): <b>${sign}$${Math.abs(r.halfDollarPnl).toFixed(2)}</b>`);
    lines.push(`  Their P&L:            <b>${pnlSign}${fmtMoney(r.totalPnl).replace('+','').replace('-','')}</b>`);
    lines.push(``);
  }

  await sendTelegram(lines.join("\n"));
}

async function pollTrades() {
  for (const trader of trackedWallets) {
    if (!trader.wallet) continue;
    let trades;
    try { trades = await fetchTrades(trader.wallet); }
    catch (e) { console.error(`[${nowStr()}] Trades error (${trader.name}): ${e.message}`); continue; }

    for (const trade of trades) {
      const tx   = trade.transactionHash || "";
      const size = parseFloat(trade.size || 0);
      if (!tx || seenTx.has(tx)) continue;
      seenTx.add(tx);
      if (size < MIN_SIZE) continue;

      console.log(`[${nowStr()}] 🔔 NEW — ${trader.name}: ${trade.side} ${fmtSize(size)}`);
      await sendTelegram(buildAlert(trade, trader));
      await new Promise(r => setTimeout(r, 500));
    }
  }
}

async function main() {
  console.log("════════════════════════════");
  console.log("  PolyTrack Bot");
  console.log("════════════════════════════\n");

  if (!TELEGRAM_TOKEN) console.warn("[WARN] TELEGRAM_TOKEN not set — alerts print here instead\n");

  await refreshLeaderboard();
  await seedSeen();
  await sendStartup();

  // Send win/loss report on startup
  await sendWinLossReport();

  console.log(`\n[${nowStr()}] Running. Checks every ${POLL_INTERVAL/1000}s. Ctrl+C to stop.\n`);

  setInterval(async () => {
    try {
      if (Date.now() - lastLeaderboardRefresh > LEADERBOARD_TTL) await refreshLeaderboard();
      await pollTrades();
    } catch (e) {
      console.error(`[${nowStr()}] Loop error: ${e.message}`);
    }
  }, POLL_INTERVAL);

  // Send win/loss report every 24 hours
  setInterval(async () => {
    await sendWinLossReport();
  }, 24 * 60 * 60 * 1000);

  // keep process alive
  await pollTrades();
}

main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
