#!/usr/bin/env python3
"""Collect inputs + actual board prints for the India gold/silver rate predictor.

Writes data/latest.json (inputs, latest prints, calibration rows) and data/history.json (accumulated
store: MCX 5-min series and every print row seen, so the calibration window keeps growing).

Rules: never invent numbers. A failed source keeps its last good value, marked ok=False with the
error. Every value carries its source, URL and its own timestamp (ISO, UTC "Z" or explicit offset).
Usage: python scraper/scrape.py --out DIR [--prev DIR]
"""
from __future__ import annotations

import argparse
import bisect
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from datetime import date, datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

IST = timezone(timedelta(hours=5, minutes=30))
UTC = timezone.utc
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
TIMEOUT = 25
MON = {m: i for i, m in enumerate(["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

URLS = {
    "yahoo": "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=15m&range=60d",
    "yahoo_page": "https://finance.yahoo.com/quote/{sym}",
    "mcx_gold": "https://mcxlive.org/gold/",
    "mcx_silver": "https://mcxlive.org/silver/",
    "ibja": "https://ibjarates.com/",
    "mjdta": "https://www.thejewellersassociation.org/",
    "gr_gold": "https://www.goodreturns.in/gold-rates/chennai.html",
    "gr_silver": "https://www.goodreturns.in/silver-rates/chennai.html",
    "goldapi": "https://api.gold-api.com/price/{sym}",
}
YAHOO = {"comex_gold": "GC=F", "comex_silver": "SI=F", "usdinr": "USDINR=X"}
# Assumed print times (IST). IBJA AM ~12:05 PM, PM ~5:00 PM; MJDTA morning ~9:40 AM, evening ~3:40 PM.
PRINT_TIME = {"AM": (12, 0), "PM": (17, 0), "Morning": (9, 40), "Evening": (15, 40)}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def num(s):
    if s is None:
        return None
    s = str(s).replace(",", "").replace("₹", "").strip()
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def get(url: str) -> requests.Response:
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en"}, timeout=TIMEOUT)
    r.raise_for_status()
    return r


def print_ts(day: str, sess: str) -> float:
    hh, mm = PRINT_TIME[sess]
    y, m, d = map(int, day.split("-"))
    return datetime(y, m, d, hh, mm, tzinfo=IST).timestamp()


# ------------------------------------------------------------------ parsers (pure, unit-tested)

def parse_yahoo(j: dict) -> dict:
    r = j["chart"]["result"][0]
    meta = r["meta"]
    ts = r.get("timestamp") or []
    closes = (r.get("indicators", {}).get("quote") or [{}])[0].get("close") or []
    bars = [[int(t), round(float(c), 4)] for t, c in zip(ts, closes) if c is not None]
    value, t = float(meta["regularMarketPrice"]), meta["regularMarketTime"]
    out = {"prevClose": meta.get("previousClose") or meta.get("chartPreviousClose"),
           "exchange": meta.get("exchangeName"), "bars": bars}
    # After the close Yahoo's regularMarketPrice for futures is the settlement, not the last trade.
    # Prefer the last 15-min bar when it is within 2 h of the market time (it is the last traded price).
    if bars and bars[-1][0] >= t - 7200 and abs(bars[-1][1] / value - 1) < 0.05:
        out["settle"] = value
        value, t = bars[-1][1], min(bars[-1][0] + 900, max(t, bars[-1][0]))
    out.update({"value": value, "t": iso(t)})
    return out


def parse_mcxlive(html: str) -> dict:
    """mcxlive.org (2026 layout): window.FD_FEED (quote, UTC datetimes) + window.FD_DATA
    (intra = 1-min [epoch-as-IST-wall-clock, price], hist = daily closes [UTC midnight of date, close])."""
    def blob(name):
        m = re.search(r"window\.%s=(\{.*?\});\s*(?:window\.|</script>)" % name, html, re.S)
        if not m:
            raise ValueError(f"mcxlive {name} not found")
        return json.loads(m.group(1))
    f, d = blob("FD_FEED"), blob("FD_DATA")
    t = datetime.strptime(f["t_datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
    shift = 19800 if d.get("tzn") == "Asia/Kolkata" else 0
    intra = [[int(p[0]) - shift, p[1]] for p in d.get("intra", []) if p and p[1]]
    hist = [[datetime.fromtimestamp(p[0], UTC).date().isoformat(), p[1]] for p in d.get("hist", [])[-120:] if p and p[1]]
    # FD_FEED "close" is not always the previous session (silver showed a stale value), so take the
    # previous close from the daily series: last daily close dated before the last trade's IST date.
    trade_day = t.astimezone(IST).date().isoformat()
    prev = [p[1] for p in hist if p[0] < trade_day]
    prev_close = prev[-1] if prev else f.get("close")
    return {"value": float(f["last"]), "prevClose": prev_close, "t": iso(t.timestamp()),
            "expiry": f.get("expiry"), "status": f.get("status"), "contract": f.get("name"),
            "high": f.get("high"), "low": f.get("low"), "intra": intra, "daily": hist}


IBJA_KEYS = [("Gold999", "g999"), ("Gold916", "g916"), ("Silver999", "s999")]


def parse_ibja_home(html: str, today: date | None = None) -> dict:
    """ibjarates.com home: today's AM/PM board + link to the 30-day PDF."""
    soup = BeautifulSoup(html, "html.parser")
    out = {"am": {}, "pm": {}}
    for label, key in IBJA_KEYS:
        for sess in ("AM", "PM"):
            el = soup.find(id=f"lbl{label}_{sess}")
            v = num(el.get_text()) if el else None
            out[sess.lower()][key] = v if v else None
    board_day = None
    hid = soup.find(id="HdnRatesAvaliable")
    if hid and hid.get("value"):
        try:
            for item in json.loads(hid["value"]):
                m = re.match(r"(\d{1,2})(AM|PM)", item.get("RateTime", ""))
                if m:
                    board_day = int(m.group(1))
        except Exception:
            pass
    d = today or datetime.now(IST).date()
    out["date"] = None
    if board_day:
        for _ in range(40):
            if d.day == board_day:
                out["date"] = d.isoformat()
                break
            d -= timedelta(days=1)
    pdf = None
    for a in soup.find_all("a", href=True):
        if "30DaysPdf" in a["href"]:
            pdf = requests.compat.urljoin(URLS["ibja"], a["href"].replace("../", "/"))
            break
    out["pdf"] = pdf
    return out


def parse_ibja_pdf_text(text: str) -> list[dict]:
    """pdftotext -layout output of IBJA 'Opening & Closing Rates' (30 days). Columns:
    date, 999 AM, 999 PM, 995 AM, 995 PM, 916 AM, 916 PM, 750 AM, 750 PM, 585 AM, 585 PM, Ag AM, Ag PM.
    A '-' means no PM print that day."""
    rows = []
    for line in text.splitlines():
        m = re.match(r"\s*(\d{2})-([A-Za-z]{3})-(\d{2})\s+(.*)$", line)
        if not m:
            continue
        toks = m.group(4).split()
        if len(toks) < 12 or not all(re.fullmatch(r"\d+(\.\d+)?|-", t) for t in toks[:12]):
            continue
        v = [None if t == "-" else float(t) for t in toks[:12]]
        day = date(2000 + int(m.group(3)), MON[m.group(2).lower()], int(m.group(1))).isoformat()
        for sess, off in (("AM", 0), ("PM", 1)):
            g999, g916, s999 = v[0 + off], v[4 + off], v[10 + off]
            if g999:
                rows.append({"date": day, "sess": sess, "g999": g999, "g916": g916, "s999": s999})
    return rows


def parse_mjdta(html: str) -> dict:
    def js_val(span_id):
        m = re.search(r"\$\('#%s'\)\.html\(\"([^\"]*)\"\)" % re.escape(span_id), html)
        return num(m.group(1)) if m and m.group(1).strip() else None
    soup = BeautifulSoup(html, "html.parser")
    silver = None
    for sp in soup.select("span.silver_rate"):
        v = num(sp.get_text())
        if v:
            silver = v
            break
    g22 = js_val("goldrate_22ct")
    m = re.search(r"\$\('#updatetime'\)\.html\(\"([^\"]*)\"\)", html)
    upd = m.group(1).strip() if m else None
    day, t, sess = None, None, None
    if upd:
        mm = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4}).*?(\d{1,2}):(\d{2})\s*([AP]M)", upd, re.I)
        if mm:
            d, mo, y, hh, mi, ap = mm.groups()
            hh = int(hh) % 12 + (12 if ap.upper() == "PM" else 0)
            dt = datetime(int(y), int(mo), int(d), hh, int(mi), tzinfo=IST)
            day, t = dt.date().isoformat(), dt.isoformat()
        sess = "Evening" if re.search(r"evening|afternoon", upd, re.I) else "Morning"
    return {"date": day, "t": t, "session": sess, "updateText": upd, "g22": g22, "silver_g": silver}


def parse_goodreturns(html: str, metal: str) -> list[dict]:
    """goodreturns Chennai 'last 10 days' table. Gold: Date | 24K | 22K (per g). Silver: Date | 10g | 100g | 1 Kg."""
    soup = BeautifulSoup(html, "html.parser")
    out = []
    for t in soup.find_all("table"):
        rows = [[c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])] for tr in t.find_all("tr")]
        if not rows or not rows[0] or rows[0][0] != "Date":
            continue
        for r in rows[1:]:
            try:
                d = datetime.strptime(r[0], "%b %d, %Y").date().isoformat()
            except ValueError:
                continue
            clean = lambda s: num(re.sub(r"\(.*?\)", "", s))
            if metal == "gold" and len(r) >= 3:
                out.append({"date": d, "g24": clean(r[1]), "g22": clean(r[2])})
            elif metal == "silver" and len(r) >= 4:
                kg = clean(r[3])
                out.append({"date": d, "silver_g": kg / 1000 if kg else None})
        if out:
            break
    return out


# ------------------------------------------------------------------ assembly helpers

class Series:
    """Sorted [ts, value] points; value_at(t) = last point at or before t within max_age seconds."""
    def __init__(self, pts):
        pts = sorted((p for p in pts if p and p[1] is not None), key=lambda p: p[0])
        self.t = [p[0] for p in pts]
        self.v = [p[1] for p in pts]

    def value_at(self, ts, max_age=4 * 3600):
        i = bisect.bisect_right(self.t, ts) - 1
        if i < 0 or ts - self.t[i] > max_age:
            return None
        return self.v[i]


STALE_OK = 64 * 3600  # weekend/holiday: the last value before the print is what the board used


def mcx_open(ts) -> bool:
    d = datetime.fromtimestamp(ts, IST)
    return d.weekday() < 5 and (9, 0) <= (d.hour, d.minute) <= (23, 55)


def mcx_at(ts, mcx5: Series, daily: list, comex: Series, fx: Series, oz_factor: float):
    """MCX price at ts: real 5-min point if within 20 min, else the previous MCX daily close carried
    forward by the COMEX x USD/INR move since that close (23:55 IST). Returns (value, how)."""
    v = mcx5.value_at(ts, max_age=20 * 60 if mcx_open(ts) else 60 * 3600)
    if v is not None:
        return v, "mcx"
    day_ist = datetime.fromtimestamp(ts, IST).date().isoformat()
    prev = [p for p in daily if p[0] < day_ist and date.fromisoformat(p[0]).weekday() < 5]
    if not prev:
        return None, None
    pday, pclose = prev[-1]
    y, m, d = map(int, pday.split("-"))
    close_ts = datetime(y, m, d, 23, 50, tzinfo=IST).timestamp()
    c1, f1 = comex.value_at(ts, STALE_OK), fx.value_at(ts, STALE_OK)
    c0, f0 = comex.value_at(close_ts, STALE_OK), fx.value_at(close_ts, STALE_OK)
    if None in (c1, f1, c0, f0):
        return None, None
    return round(pclose * (c1 * f1) / (c0 * f0)), "recon"


def run_source(prev_entry, fn, url, label, tries=2):
    attempt = now_iso()
    err = None
    for i in range(tries):
        try:
            data = fn()
            return {"ok": True, "source": label, "url": url, "fetchedAt": attempt, "data": data}
        except Exception as e:  # noqa: BLE001
            err = f"{type(e).__name__}: {str(e)[:160]}"
            time.sleep(2 * (i + 1))
    out = {"ok": False, "source": label, "url": url, "lastAttempt": attempt, "error": err}
    if prev_entry and prev_entry.get("data") is not None:
        out["data"] = prev_entry["data"]
        out["fetchedAt"] = prev_entry.get("fetchedAt")
    return out


def fetch_ibja_pdf(url):
    raw = get(url.replace(" ", "%20")).content
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(raw)
        f.flush()
        text = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout
    rows = parse_ibja_pdf_text(text)
    if len(rows) < 5:
        raise ValueError("IBJA PDF: too few rows")
    return rows


def scrape(prev_latest, prev_hist):
    ps = (prev_latest or {}).get("raw", {})
    hist = copy.deepcopy(prev_hist) if prev_hist else {"schema": 1, "mcx5": {"gold": [], "silver": []},
                                                       "ibja": {}, "chennai": {}, "pdfFetchedAt": None}
    raw = {}
    for key, sym in YAHOO.items():
        raw[key] = run_source(ps.get(key), lambda sym=sym: parse_yahoo(get(URLS["yahoo"].format(sym=sym)).json()),
                              URLS["yahoo_page"].format(sym=sym), "Yahoo Finance")
    for metal in ("gold", "silver"):
        raw[f"mcx_{metal}"] = run_source(ps.get(f"mcx_{metal}"), lambda metal=metal: parse_mcxlive(get(URLS[f"mcx_{metal}"]).text),
                                         URLS[f"mcx_{metal}"], "mcxlive.org (unofficial, delayed)")
    for sym in ("XAU", "XAG"):
        def ga(sym=sym):
            j = get(URLS["goldapi"].format(sym=sym)).json()
            return {"value": float(j["price"]), "t": j["updatedAt"]}
        raw[f"spot_{sym.lower()}"] = run_source(ps.get(f"spot_{sym.lower()}"), ga, URLS["goldapi"].format(sym=sym), "gold-api.com (spot)")
    raw["ibja"] = run_source(ps.get("ibja"), lambda: parse_ibja_home(get(URLS["ibja"]).text), URLS["ibja"], "IBJA (ibjarates.com)")
    raw["mjdta"] = run_source(ps.get("mjdta"), lambda: parse_mjdta(get(URLS["mjdta"]).text), URLS["mjdta"], "MJDTA (thejewellersassociation.org)")

    # IBJA 30-day PDF: at most hourly (it only changes once or twice a day).
    pdf_url = (raw["ibja"].get("data") or {}).get("pdf")
    last = hist.get("pdfFetchedAt")
    if pdf_url and (not last or time.time() - to_ts(last) > 3600 or not hist["ibja"]):
        pdf = run_source(None, lambda: fetch_ibja_pdf(pdf_url), pdf_url, "IBJA 30-day PDF")
        raw["ibja_pdf"] = {k: v for k, v in pdf.items() if k != "data"}
        if pdf["ok"]:
            hist["pdfFetchedAt"] = pdf["fetchedAt"]
            for r in pdf["data"]:
                hist["ibja"][f"{r['date']}|{r['sess']}"] = {**r, "src": "IBJA 30-day PDF"}
    else:
        raw["ibja_pdf"] = (ps.get("ibja_pdf") or {"ok": True, "source": "IBJA 30-day PDF", "url": pdf_url})
    if raw["ibja"]["ok"]:
        b = raw["ibja"]["data"]
        for sess in ("AM", "PM"):
            vals = b.get(sess.lower()) or {}
            if b.get("date") and vals.get("g999"):
                hist["ibja"][f"{b['date']}|{sess}"] = {"date": b["date"], "sess": sess, **vals, "src": "IBJA board"}

    for metal in ("gold", "silver"):
        gr = run_source(None, lambda metal=metal: parse_goodreturns(get(URLS[f"gr_{metal}"]).text, metal),
                        URLS[f"gr_{metal}"], "goodreturns.in (Chennai)")
        raw[f"gr_{metal}"] = {k: v for k, v in gr.items() if k != "data"}
        if gr["ok"]:
            for r in gr["data"]:
                e = hist["chennai"].setdefault(r["date"], {"date": r["date"], "sess": "Morning", "src": "goodreturns.in"})
                if e.get("src") != "MJDTA":
                    for k in ("g22", "silver_g"):
                        if r.get(k):
                            e[k] = r[k]
    if raw["mjdta"]["ok"] and raw["mjdta"]["data"].get("date"):
        m = raw["mjdta"]["data"]
        hist["chennai"][m["date"]] = {"date": m["date"], "sess": m["session"] or "Morning", "g22": m["g22"],
                                      "silver_g": m["silver_g"], "src": "MJDTA", "t": m["t"]}

    # Accumulate MCX 5-min points (true UTC) so old prints keep real MCX values after mcxlive's 5-day window.
    for metal in ("gold", "silver"):
        e = raw[f"mcx_{metal}"]
        if e["ok"]:
            pts = {p[0] // 300 * 300: p[1] for p in hist["mcx5"].get(metal, [])}
            for t, v in e["data"]["intra"]:
                pts[t // 300 * 300] = v
            cutoff = time.time() - 120 * 86400
            hist["mcx5"][metal] = [[t, v] for t, v in sorted(pts.items()) if t >= cutoff]
    cutoff_day = (datetime.now(IST).date() - timedelta(days=150)).isoformat()
    hist["ibja"] = {k: v for k, v in sorted(hist["ibja"].items()) if v["date"] >= cutoff_day}
    hist["chennai"] = {k: v for k, v in sorted(hist["chennai"].items()) if v["date"] >= cutoff_day}
    hist["updatedAt"] = now_iso()
    return raw, hist


def build_rows(raw, hist):
    """Calibration/backtest rows: each actual print with the inputs as they were at the print time."""
    ser = {k: Series((raw.get(k, {}).get("data") or {}).get("bars", [])) for k in YAHOO}
    mcx5 = {m: Series(hist["mcx5"].get(m, [])) for m in ("gold", "silver")}
    daily = {m: (raw.get(f"mcx_{m}", {}).get("data") or {}).get("daily", []) for m in ("gold", "silver")}

    def inputs(ts):
        cg, cs, fx = (ser["comex_gold"].value_at(ts, STALE_OK), ser["comex_silver"].value_at(ts, STALE_OK),
                      ser["usdinr"].value_at(ts, STALE_OK))
        mg, hg = mcx_at(ts, mcx5["gold"], daily["gold"], ser["comex_gold"], ser["usdinr"], 0)
        ms, hs = mcx_at(ts, mcx5["silver"], daily["silver"], ser["comex_silver"], ser["usdinr"], 0)
        return {"cg": cg, "cs": cs, "fx": fx, "mg": mg, "ms": ms, "mgHow": hg, "msHow": hs}

    rows = []
    for k, r in hist["ibja"].items():
        ts = print_ts(r["date"], r["sess"])
        rows.append({"k": "ibja", "date": r["date"], "sess": r["sess"], "t": iso(ts),
                     "a": {"g999": r.get("g999"), "g916": r.get("g916"), "s999": r.get("s999")}, "x": inputs(ts)})
    for k, r in hist["chennai"].items():
        if date.fromisoformat(r["date"]).weekday() == 6:
            continue  # MJDTA does not print on Sundays; goodreturns just repeats Saturday
        ts = to_ts(r["t"]) if r.get("t") else print_ts(r["date"], r.get("sess") or "Morning")
        rows.append({"k": "chennai", "date": r["date"], "sess": r.get("sess"), "t": iso(ts), "src": r.get("src"),
                     "a": {"g22": r.get("g22"), "silver_g": r.get("silver_g")}, "x": inputs(ts)})
    rows.sort(key=lambda r: r["t"])
    return rows


def build_latest(raw, hist):
    def inp(key, label, unit):
        e = raw.get(key, {})
        d = e.get("data") or {}
        out = {"ok": e.get("ok", False), "label": label, "unit": unit, "source": e.get("source"), "url": e.get("url"),
               "value": d.get("value"), "t": d.get("t"), "prevClose": d.get("prevClose"), "fetchedAt": e.get("fetchedAt")}
        for k in ("expiry", "status", "contract", "exchange"):
            if d.get(k):
                out[k] = d[k]
        if not e.get("ok"):
            out["error"] = e.get("error")
        return out
    ib_rows = sorted(hist["ibja"].values(), key=lambda r: (r["date"], r["sess"]))
    ch_rows = sorted(hist["chennai"].values(), key=lambda r: r["date"])
    return {
        "schema": 1, "generatedAt": now_iso(),
        "inputs": {
            "comex_gold": inp("comex_gold", "COMEX gold (GC=F front month)", "USD/oz"),
            "comex_silver": inp("comex_silver", "COMEX silver (SI=F front month)", "USD/oz"),
            "usdinr": inp("usdinr", "USD/INR", "INR"),
            "mcx_gold": inp("mcx_gold", "MCX gold (near month)", "INR/10g"),
            "mcx_silver": inp("mcx_silver", "MCX silver (near month)", "INR/kg"),
            "spot_xau": inp("spot_xau", "Gold spot", "USD/oz"),
            "spot_xag": inp("spot_xag", "Silver spot", "USD/oz"),
        },
        "prints": {"ibja": ib_rows[-2:], "chennai": ch_rows[-2:]},
        "status": {k: ({"ok": v.get("ok"), "source": v.get("source"), "url": v.get("url"), "fetchedAt": v.get("fetchedAt"),
                        "error": v.get("error")}) for k, v in raw.items()},
        "rows": build_rows(raw, hist),
    }


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def fingerprint(latest):
    keep = {"inputs": {k: (v.get("value"), v.get("t")) for k, v in latest["inputs"].items()}, "prints": latest["prints"]}
    return json.dumps(keep, sort_keys=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", default=None)
    a = ap.parse_args()
    pdir = a.prev or a.out
    prev_latest, prev_hist = load(os.path.join(pdir, "state.json")), load(os.path.join(pdir, "history.json"))
    raw, hist = scrape(prev_latest, prev_hist)
    latest = build_latest(raw, hist)
    prev_pub = load(os.path.join(pdir, "latest.json"))
    changed = prev_pub is None or fingerprint(prev_pub) != fingerprint(latest)
    os.makedirs(a.out, exist_ok=True)
    slim_raw = {k: ({**v, "data": {kk: vv for kk, vv in (v.get("data") or {}).items() if kk not in ("intra",)}}
                    if isinstance(v.get("data"), dict) else v) for k, v in raw.items()}
    with open(os.path.join(a.out, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(a.out, "history.json"), "w", encoding="utf-8") as f:
        json.dump(hist, f, separators=(",", ":"))
    with open(os.path.join(a.out, "state.json"), "w", encoding="utf-8") as f:
        json.dump({"raw": slim_raw}, f, separators=(",", ":"))
    print(json.dumps({k: ("ok" if v.get("ok") else "FAIL " + str(v.get("error"))) for k, v in raw.items()}, indent=1))
    print(f"rows={len(latest['rows'])}")
    print("CHANGED" if changed else "UNCHANGED")


if __name__ == "__main__":
    sys.exit(main())
