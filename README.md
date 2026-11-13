# Gold · Silver · FX — live dashboard

Live page: https://moulisankar999.github.io/gold-silver-fx-dashboard/

A static, installable (PWA) dashboard for Chennai (MJDTA/CWJA), IBJA, MCX near-month futures,
international spot gold/silver (converted to INR) and FX, with a step-by-step silver landed-cost breakdown.
Times are shown in MYT with IST alongside.

## How data gets in
| Section | Source | How | Cadence |
|---|---|---|---|
| Chennai | thejewellersassociation.org (MJDTA), cwja.org.in fallback | GitHub Actions scraper | every 10 min (see below) |
| IBJA | ibjarates.com | GitHub Actions scraper | every 10 min + extra runs after 12:05 PM and 5:00 PM IST (weekdays) |
| MCX futures | mcxlive.org (gold, silver near-month) | GitHub Actions scraper | every 10 min (delayed, not tick data) |
| Spot XAU/XAG | api.gold-api.com | browser, live | every 30 s (scraper copy as fallback) |
| FX | gold-api.com (USD, GBP, SGD, EUR live), Yahoo Finance via scraper (all pairs incl. MYR, AED, SGD/MYR), open.er-api.com (daily) | freshest wins | 30 s / ~10 min / daily |

**Simple view (default):** gold and silver in three rows each (World / India-IBJA / Chennai-MJDTA) with
International rate → Import duty (15%: BCD 10% + AIDC 5%, since 13 May 2026) → GST 3% → dealer premium/discount →
final cost in India, ▲/▼ arrows and USD in brackets, plus GBP/USD/MYR→INR and GBP→MYR. "Detailed" shows everything else.

**Schedule:** GitHub drops most `*/10` cron runs on small repos, so `scraper/loop.sh` scrapes every 10 min for
~45 min inside one run, and during 7:00 AM–11:30 PM IST (Mon–Sat) each run queues the next (`gh workflow run`).
The `scrape` concurrency group allows one running + one queued, so the chain never multiplies. Crons restart it.

The scraper (`scraper/scrape.py`) writes `data/latest.json` and a rolling `data/history.json` to the
`data` branch. It force-pushes a single commit, and only when values change, so history never churns.
A failed source keeps its last good value, marked `ok: false` with the error, and the page shows it as
"Unavailable" with that value's own timestamp.

## Tests
```
node --test tests/calc.test.mjs     # unit conversions, duty/GST maths, time windows
python3 tests/test_parsers.py       # parsers against saved pages
```

Shop price = IBJA + premium + 3% GST; not financial advice.
