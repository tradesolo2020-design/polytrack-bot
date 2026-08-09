"""
Polymarket Top Trader Tracker — Telegram Bot
Polls the top 3 leaderboard traders and sends alerts when they make new trades.
"""

import os
import time
import json
import requests
from datetime import datetime, timezone

# ── Config ──────────────────────────────────────────────────────────────────
TELEGRAM_TOKEN  = os.environ.get("TELEGRAM_TOKEN", "")   # from @BotFather
TELEGRAM_CHAT   = os.environ.get("TELEGRAM_CHAT", "")    # your personal chat ID
POLL_INTERVAL   = int(os.environ.get("POLL_INTERVAL", "120"))  # seconds
LEADERBOARD_PERIOD = os.environ.get("LEADERBOARD_PERIOD", "ALL")  # DAY/WEEK/MONTH/ALL
MIN_TRADE_SIZE  = float(os.environ.get("MIN_TRADE_SIZE", "0.50"))

BASE = "https://data-api.polymarket.com"
POLYMARKET_URL = "https://polymarket.com/event"

# ── State ────────────────────────────────────────────────────────────────────
seen_tx_hashes: set[str] = set()
tracked_wallets: list[dict] = []   # [{wallet, name, rank, pnl}]
last_leaderboard_refresh = 0
LEADERBOARD_TTL = 3600  # refresh top-3 every hour


# ── Helpers ──────────────────────────────────────────────────────────────────
def fmt_money(n: float, sign: bool = True) -> str:
    n = float(n or 0)
    prefix = ("+" if n >= 0 else "-") if sign else ""
    abs_n = abs(n)
    if abs_n >= 1_000_000:
        return f"{prefix}${abs_n/1e6:.2f}M"
    if abs_n >= 1_000:
        return f"{prefix}${abs_n/1e3:.1f}K"
    return f"{prefix}${abs_n:.2f}"


def fmt_size(n: float) -> str:
    n = float(n or 0)
    if n >= 1_000_000:
        return f"${n/1e6:.2f}M"
    if n >= 1_000:
        return f"${n/1e3:.1f}K"
    return f"${n:.2f}"


def rank_emoji(rank: int) -> str:
    return {1: "🥇", 2: "🥈", 3: "🥉"}.get(rank, f"#{rank}")


def side_emoji(side: str) -> str:
    return "🟢" if side.upper() == "BUY" else "🔴"


def price_to_cents(price: float) -> str:
    return f"{price * 100:.1f}¢"


def ts_to_str(ts: int) -> str:
    dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    return dt.strftime("%b %d %H:%M UTC")


# ── API calls ────────────────────────────────────────────────────────────────
def fetch_leaderboard() -> list[dict]:
    r = requests.get(
        f"{BASE}/v1/leaderboard",
        params={"limit": 3, "orderBy": "PNL", "timePeriod": LEADERBOARD_PERIOD},
        timeout=15,
    )
    r.raise_for_status()
    return r.json()


def fetch_trades(wallet: str, limit: int = 50) -> list[dict]:
    r = requests.get(
        f"{BASE}/trades",
        params={"user": wallet, "limit": limit, "takerOnly": "false"},
        timeout=15,
    )
    r.raise_for_status()
    data = r.json()
    return data if isinstance(data, list) else []


# ── Telegram ─────────────────────────────────────────────────────────────────
def send_telegram(text: str) -> bool:
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT:
        print("[WARN] Telegram not configured — printing to console instead")
        print(text)
        return True
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": False,
    }
    try:
        r = requests.post(url, json=payload, timeout=10)
        r.raise_for_status()
        return True
    except Exception as e:
        print(f"[ERROR] Telegram send failed: {e}")
        return False


def build_trade_message(trade: dict, trader: dict) -> str:
    side = trade.get("side", "").upper()
    size = float(trade.get("size", 0))
    price = float(trade.get("price", 0))
    title = trade.get("title") or trade.get("slug") or "Unknown market"
    outcome = trade.get("outcome") or "—"
    event_slug = trade.get("eventSlug") or trade.get("slug") or ""
    ts = trade.get("timestamp")

    market_url = f"{POLYMARKET_URL}/{event_slug}" if event_slug else "https://polymarket.com"

    # implied probability move hint
    prob_hint = ""
    if price > 0:
        if price < 0.15:
            prob_hint = "  ⚠️ Low prob bet"
        elif price > 0.85:
            prob_hint = "  ✅ High confidence"

    lines = [
        f"{side_emoji(side)} <b>{side}</b>  ·  {rank_emoji(trader['rank'])} <b>{trader['name']}</b>",
        f"",
        f"📋 <b>{title}</b>",
        f"",
        f"  Outcome:  <b>{outcome}</b>",
        f"  Price:    <b>{price_to_cents(price)}</b>{prob_hint}",
        f"  Size:     <b>{fmt_size(size)}</b>",
        f"  Trader PnL:  <b>{fmt_money(trader['pnl'])}</b>  (all-time)",
        f"",
        f"🕐 {ts_to_str(ts) if ts else 'just now'}",
        f"",
        f"<a href=\"{market_url}\">▶️ Open on Polymarket to mirror</a>",
    ]
    return "\n".join(lines)


def send_startup_message(wallets: list[dict]) -> None:
    lines = ["<b>📡 PolyTrack Bot started</b>", ""]
    lines.append(f"Tracking top {len(wallets)} traders — period: <b>{LEADERBOARD_PERIOD}</b>")
    lines.append(f"Min trade size: <b>{fmt_size(MIN_TRADE_SIZE)}</b>")
    lines.append(f"Poll interval: <b>{POLL_INTERVAL}s</b>")
    lines.append("")
    for w in wallets:
        lines.append(
            f"{rank_emoji(w['rank'])} <b>{w['name']}</b>  {fmt_money(w['pnl'])}"
        )
        lines.append(f"   <code>{w['wallet']}</code>")
    lines.append("")
    lines.append("Alerts will fire here when they trade.")
    send_telegram("\n".join(lines))


# ── Core loop ────────────────────────────────────────────────────────────────
def refresh_leaderboard() -> None:
    global tracked_wallets, last_leaderboard_refresh
    print(f"[{ts_now()}] Refreshing leaderboard…")
    try:
        leaders = fetch_leaderboard()
        tracked_wallets = []
        for i, trader in enumerate(leaders[:3], start=1):
            wallet = trader.get("proxyWallet") or ""
            name = trader.get("userName") or wallet[:8] + "…"
            pnl = float(trader.get("pnl") or 0)
            tracked_wallets.append({"rank": i, "name": name, "wallet": wallet, "pnl": pnl})
            print(f"  {rank_emoji(i)} {name}  {fmt_money(pnl)}  {wallet}")
        last_leaderboard_refresh = time.time()
    except Exception as e:
        print(f"[ERROR] Leaderboard fetch failed: {e}")


def poll_trades() -> None:
    for trader in tracked_wallets:
        wallet = trader["wallet"]
        if not wallet:
            continue
        try:
            trades = fetch_trades(wallet, limit=20)
        except Exception as e:
            print(f"[ERROR] Trades for {wallet[:8]}…: {e}")
            continue

        new_count = 0
        for trade in trades:
            tx = trade.get("transactionHash") or ""
            if not tx or tx in seen_tx_hashes:
                continue

            size = float(trade.get("size", 0))
            if size < MIN_TRADE_SIZE:
                seen_tx_hashes.add(tx)
                continue

            seen_tx_hashes.add(tx)
            new_count += 1
            msg = build_trade_message(trade, trader)
            print(f"[{ts_now()}] NEW TRADE from {trader['name']}: {trade.get('side')} {fmt_size(size)}")
            send_telegram(msg)
            time.sleep(0.5)  # don't spam Telegram

        if new_count:
            print(f"  → Sent {new_count} alert(s) for {trader['name']}")


def seed_seen_hashes() -> None:
    """On startup, load existing trades so we don't replay history."""
    print(f"[{ts_now()}] Seeding known trades to suppress history…")
    for trader in tracked_wallets:
        wallet = trader["wallet"]
        if not wallet:
            continue
        try:
            trades = fetch_trades(wallet, limit=100)
            for t in trades:
                tx = t.get("transactionHash")
                if tx:
                    seen_tx_hashes.add(tx)
            print(f"  Seeded {len(trades)} trades for {trader['name']}")
        except Exception as e:
            print(f"[ERROR] Seed failed for {wallet[:8]}…: {e}")


def ts_now() -> str:
    return datetime.now(tz=timezone.utc).strftime("%H:%M:%S")


def main() -> None:
    print("=" * 50)
    print("  PolyTrack Bot")
    print("=" * 50)

    if not TELEGRAM_TOKEN:
        print("\n[WARN] TELEGRAM_TOKEN not set. Messages will print to console.\n")

    refresh_leaderboard()

    if not tracked_wallets:
        print("[ERROR] No wallets to track. Check API connectivity.")
        return

    seed_seen_hashes()
    send_startup_message(tracked_wallets)

    print(f"\n[{ts_now()}] Polling every {POLL_INTERVAL}s. Ctrl+C to stop.\n")

    while True:
        try:
            # Refresh leaderboard hourly
            if time.time() - last_leaderboard_refresh > LEADERBOARD_TTL:
                refresh_leaderboard()

            poll_trades()
            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            print("\nStopped.")
            break
        except Exception as e:
            print(f"[ERROR] Unexpected: {e}")
            time.sleep(30)


if __name__ == "__main__":
    main()
