#!/usr/bin/env python3
"""Scrape gold, silver and FX sources into data/latest.json and data/history.json.

Rules:
- Never invent numbers. If a source fails, keep its last good value and mark ok=False
  with the error and the time of the failed attempt.
- Every value carries its source URL and its own timestamp.
Usage: python scraper/scrape.py --out DIR [--prev DIR]
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta, timezone

import requests
from bs4 import BeautifulSoup

IST = timezone(timedelta(hours=5, minutes=30))
UTC = timezone.utc
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")
TIMEOUT = 25
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}

URLS = {
    "mjdta": "https://www.thejewellersassociation.org/",
    "cwja": "https://cwja.org.in/",
    "ibja": "https://ibjarates.com/",
    "mcx_gold": "https://mcxlive.org/gold/",
    "mcx_silver": "https://mcxlive.org/silver/",
    "goldapi": "https://api.gold-api.com/price/{sym}",
    "yahoo": "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=5m&range=1d",
    "erapi": "https://open.er-api.com/v6/latest/USD",
}
FX_PAIRS = {  # display key -> yahoo symbol
    "USDINR": "USDINR=X", "MYRINR": "MYRINR=X", "GBPINR": "GBPINR=X",
    "SGDINR": "SGDINR=X", "EURINR": "EURINR=X", "AEDINR": "AEDINR=X",
    "SGDMYR": "SGDMYR=X", "GBPMYR": "GBPMYR=X",
}


def now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def num(s) -> float | None:
    if s is None:
        return None
    s = str(s).replace(",", "").replace("₹", "").strip()
    m = re.search(r"[-+]?\d+(?:\.\d+)?", s)
    return float(m.group(0)) if m else None


def get(url: str, **kw) -> requests.Response:
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "en"}, timeout=TIMEOUT, **kw)
    r.raise_for_status()
    return r


# ---------------------------------------------------------------- parsers (pure)

def parse_mjdta(html: str) -> dict:
    """MJDTA home page. Rates are set by inline jQuery; silver by a visible span."""
    def js_val(span_id):
        m = re.search(r"\$\('#%s'\)\.html\(\"([^\"]*)\"\)" % re.escape(span_id), html)
        return num(m.group(1)) if m and m.group(1).strip() else None

    def js_diff(var):
        m = re.search(r"var %s\s*=\s*(?:parseFloat\()?\"([^\"]*)\"" % re.escape(var), html)
        return num(m.group(1)) if m else None

    soup = BeautifulSoup(html, "html.parser")
    silver = None
    for sp in soup.select("span.silver_rate"):
        v = num(sp.get_text())
        if v:
            silver = v
            break
    g22 = js_val("goldrate_22ct")
    if g22 is None:
        hidden = soup.select("span.gold_rate")
        for sp in hidden:
            v = num(sp.get_text())
            if v:
                g22 = v
                break
    upd = None
    m = re.search(r"\$\('#updatetime'\)\.html\(\"([^\"]*)\"\)", html)
    if m:
        upd = m.group(1).strip()
    values = {"g22": g22, "g18": js_val("goldrate_18ct"), "g14": js_val("goldrate_14ct"), "silver_g": silver}
    diffs = {"g22": js_diff("goldrate_22ctdiff"), "g18": js_diff("goldrate_18ctdiff"),
             "g14": js_diff("goldrate_14ctdiff"), "silver_g": js_diff("silverrate_1gmdiff")}
    return {"values": values, "diff": diffs, "updateText": upd, "updatedAt": parse_mjdta_time(upd),
            "session": ("Evening" if upd and re.search(r"evening|afternoon", upd, re.I) else
                        "Morning" if upd and re.search(r"morning", upd, re.I) else None)}


def parse_mjdta_time(text: str | None) -> str | None:
    # "12/11/2026 Morning 09:38 AM"
    if not text:
        return None
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{4}).*?(\d{1,2}):(\d{2})\s*([AP]M)", text, re.I)
    if not m:
        return None
    d, mo, y, hh, mm, ap = m.groups()
    hh = int(hh) % 12 + (12 if ap.upper() == "PM" else 0)
    return datetime(int(y), int(mo), int(d), hh, int(mm), tzinfo=IST).isoformat()


def parse_cwja(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    text = soup.get_text(" ", strip=True)
    def after(label):
        m = re.search(re.escape(label) + r"\s*\(₹\)\s*([\d,]+(?:\.\d+)?)", text)
        return num(m.group(1)) if m else None
    upd = None
    m = re.search(r"Update Time\s*:\s*(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)", text, re.I)
    if m:
        d, mo, y, hh, mi, ss, ap = m.groups()
        hh = int(hh) % 12 + (12 if ap.lower() == "pm" else 0)
        upd = datetime(int(y), int(mo), int(d), hh, int(mi), int(ss or 0), tzinfo=IST).isoformat()
    return {"values": {"g22": after("1 Gm Gold 22Kt"), "g18": after("1 Gm Gold 18Kt"),
                       "g14": after("1 Gm Gold 14Kt"), "silver_g": after("1 Gm Silver")},
            "updatedAt": upd}


IBJA_KEYS = [("Gold999", "g999"), ("Gold995", "g995"), ("Gold916", "g916"), ("Gold750", "g750"),
             ("Gold585", "g585"), ("Silver999", "s999"), ("Platinum999", "p999")]


def parse_ibja(html: str, today_ist: datetime | None = None) -> dict:
    """ibjarates.com: today's AM/PM board (gold per 10g, silver/platinum per kg) + 30-day history."""
    soup = BeautifulSoup(html, "html.parser")
    am, pm = {}, {}
    for label, key in IBJA_KEYS:
        for sess, dst in (("AM", am), ("PM", pm)):
            el = soup.find(id=f"lbl{label}_{sess}")
            v = num(el.get_text()) if el else None
            dst[key] = v if v else None
    # Board date: hidden field like [{"ID":"41124","RateTime":"12AM"}] -> day of month + session
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
    today_ist = today_ist or datetime.now(IST)
    board_date = None
    if board_day:
        d = today_ist.date()
        for _ in range(40):
            if d.day == board_day:
                board_date = d.isoformat()
                break
            d -= timedelta(days=1)
    hist = {"am": [], "pm": []}
    for sess in ("am", "pm"):
        pane = soup.find(id=f"tab-{sess}")
        if not pane:
            continue
        for tr in pane.select("tbody tr"):
            tds = tr.find_all("td")
            if len(tds) < 8:
                continue
            m = re.match(r"(\d{2})/(\d{2})/(\d{4})", tds[0].get_text(strip=True))
            if not m:
                continue
            row = {"date": f"{m.group(3)}-{m.group(2)}-{m.group(1)}"}
            for (lab, key), td in zip(IBJA_KEYS, tds[1:8]):
                row[key] = num(td.get_text())
            hist[sess].append(row)
    has_am = any(am.values())
    has_pm = any(pm.values())
    return {"date": board_date, "am": am if has_am else None, "pm": pm if has_pm else None,
            "history": hist, "units": {"gold": "10g", "silver": "kg", "platinum": "10g"}}


def _mcx_dt(day: str, mon: str, year: int, hh: str, mm: str) -> str:
    h = int(hh)  # site prints 24h clock with a spurious AM/PM suffix ("14:29 PM")
    return datetime(year, MONTHS[mon[:3].lower()], int(day), h, int(mm), tzinfo=IST).isoformat()


def parse_mcxlive(html: str) -> dict:
    soup = BeautifulSoup(html, "html.parser")
    for s in soup(["script", "style"]):
        s.decompose()
    text = soup.get_text(" ", strip=True)
    out = {}
    m = re.search(r"MCX (Gold|Silver) (\d{1,2} [A-Za-z]{3} \d{4}) As on [A-Za-z]+, (\d{1,2}) ([A-Za-z]{3}) (\d{4}) (\d{1,2}):(\d{2})", text)
    if not m:
        raise ValueError("mcxlive layout not recognised")
    out["contract"] = m.group(2)
    year = int(m.group(5))
    out["asOf"] = _mcx_dt(m.group(3), m.group(4), year, m.group(6), m.group(7))
    lt = re.search(r"Last Trade on (\d{1,2}) ([A-Za-z]{3}) (\d{1,2}):(\d{2})\s*[AP]?M?,\s*Market (Open|Closed)", text)
    if lt:
        out["lastTrade"] = _mcx_dt(lt.group(1), lt.group(2), year, lt.group(3), lt.group(4))
        out["marketStatus"] = lt.group(5)
    q = re.search(r"Last Trade Change Change in % ([\d,\.]+) ([-+]?[\d,\.]+) ([-+]?[\d\.]+)% High Low Open ([\d,\.]+) ([\d,\.]+) ([\d,\.]+)", text)
    if not q:
        raise ValueError("mcxlive quote block not found")
    out.update({"ltp": num(q.group(1)), "change": num(q.group(2)), "changePct": num(q.group(3)),
                "high": num(q.group(4)), "low": num(q.group(5)), "open": num(q.group(6))})
    exp = datetime.strptime(out["contract"], "%d %b %Y").date()
    out["expiry"] = exp.isoformat()
    return out


# ---------------------------------------------------------------- fetchers

def fetch_mjdta():
    r = get(URLS["mjdta"])
    d = parse_mjdta(r.text)
    if not d["values"]["g22"]:
        raise ValueError("22K value missing on MJDTA page")
    return d


def fetch_cwja():
    d = parse_cwja(get(URLS["cwja"]).text)
    if not d["values"]["g22"]:
        raise ValueError("22K value missing on CWJA page")
    return d


def fetch_ibja():
    d = parse_ibja(get(URLS["ibja"]).text)
    if not d["am"] and not d["pm"]:
        raise ValueError("IBJA board empty")
    return d


def fetch_mcx(metal):
    d = parse_mcxlive(get(URLS[f"mcx_{metal}"]).text)
    d["unit"] = "10g" if metal == "gold" else "kg"
    return d


def fetch_goldapi(sym):
    j = get(URLS["goldapi"].format(sym=sym)).json()
    return {"usdPerOz": float(j["price"]), "updatedAt": j["updatedAt"]}


def fetch_yahoo(sym):
    j = get(URLS["yahoo"].format(sym=sym)).json()
    meta = j["chart"]["result"][0]["meta"]
    t = datetime.fromtimestamp(meta["regularMarketTime"], UTC).isoformat().replace("+00:00", "Z")
    return {"rate": float(meta["regularMarketPrice"]), "updatedAt": t,
            "prevClose": meta.get("chartPreviousClose") or meta.get("previousClose")}


def fetch_erapi():
    j = get(URLS["erapi"]).json()
    if j.get("result") != "success":
        raise ValueError("open.er-api result not success")
    keep = {k: j["rates"][k] for k in ("INR", "MYR", "GBP", "SGD", "EUR", "AED") if k in j["rates"]}
    t = datetime.fromtimestamp(j["time_last_update_unix"], UTC).isoformat().replace("+00:00", "Z")
    return {"usdRates": keep, "updatedAt": t}


# ---------------------------------------------------------------- assembly

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
    if prev_entry and prev_entry.get("data"):
        out["data"] = prev_entry["data"]
        out["fetchedAt"] = prev_entry.get("fetchedAt")
    return out


def scrape(prev: dict | None) -> dict:
    ps = (prev or {}).get("sources", {})
    s = {}
    s["mjdta"] = run_source(ps.get("mjdta"), fetch_mjdta, URLS["mjdta"], "MJDTA (thejewellersassociation.org)")
    s["cwja"] = run_source(ps.get("cwja"), fetch_cwja, URLS["cwja"], "CWJA (cwja.org.in)")
    s["ibja"] = run_source(ps.get("ibja"), fetch_ibja, URLS["ibja"], "IBJA (ibjarates.com)")
    s["mcx_gold"] = run_source(ps.get("mcx_gold"), lambda: fetch_mcx("gold"), URLS["mcx_gold"], "mcxlive.org")
    s["mcx_silver"] = run_source(ps.get("mcx_silver"), lambda: fetch_mcx("silver"), URLS["mcx_silver"], "mcxlive.org")
    s["spot_xau"] = run_source(ps.get("spot_xau"), lambda: fetch_goldapi("XAU"), URLS["goldapi"].format(sym="XAU"), "gold-api.com")
    s["spot_xag"] = run_source(ps.get("spot_xag"), lambda: fetch_goldapi("XAG"), URLS["goldapi"].format(sym="XAG"), "gold-api.com")
    for key, sym in FX_PAIRS.items():
        s[f"fx_{key}"] = run_source(ps.get(f"fx_{key}"), lambda sym=sym: fetch_yahoo(sym),
                                    URLS["yahoo"].format(sym=sym).split("?")[0], "Yahoo Finance")
    s["erapi"] = run_source(ps.get("erapi"), fetch_erapi, URLS["erapi"], "open.er-api.com")
    return {"schema": 1, "generatedAt": now_iso(), "sources": s}


def series_points(latest: dict) -> dict:
    """Values tracked in history.json (one number per series, with the value's own time)."""
    s = latest["sources"]
    out = {}
    def put(key, val, t):
        if val is not None and t:
            out[key] = (val, t)
    for src in ("mjdta",):
        e = s.get(src, {})
        if e.get("ok"):
            d = e["data"]
            put("mjdta_g22", d["values"].get("g22"), d.get("updatedAt") or e["fetchedAt"])
            put("mjdta_silver_g", d["values"].get("silver_g"), d.get("updatedAt") or e["fetchedAt"])
    e = s.get("ibja", {})
    if e.get("ok"):
        d = e["data"]
        sess = d.get("pm") or d.get("am")
        stamp = (d.get("date") or "") + ("T17:00:00+05:30" if d.get("pm") else "T12:05:00+05:30")
        if sess:
            put("ibja_g999", sess.get("g999"), stamp)
            put("ibja_s999", sess.get("s999"), stamp)
    for m in ("gold", "silver"):
        e = s.get(f"mcx_{m}", {})
        if e.get("ok"):
            put(f"mcx_{m}", e["data"].get("ltp"), e["data"].get("lastTrade") or e["data"].get("asOf"))
    for k in ("xau", "xag"):
        e = s.get(f"spot_{k}", {})
        if e.get("ok"):
            put(f"spot_{k}", e["data"]["usdPerOz"], e["data"]["updatedAt"])
    for key in FX_PAIRS:
        e = s.get(f"fx_{key}", {})
        if e.get("ok"):
            put(f"fx_{key}", e["data"]["rate"], e["data"]["updatedAt"])
    return out


def to_epoch(iso: str) -> int:
    return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def update_history(hist: dict | None, latest: dict, max_points=600, max_days=45) -> dict:
    hist = copy.deepcopy(hist) if hist else {"schema": 1, "series": {}}
    cutoff = time.time() - max_days * 86400
    for key, (val, t) in series_points(latest).items():
        ser = hist["series"].setdefault(key, [])
        ts = to_epoch(t)
        if ser and (ser[-1][1] == val or ser[-1][0] >= ts):
            continue  # unchanged value or not newer
        ser.append([ts, val])
    for key, ser in hist["series"].items():
        hist["series"][key] = [p for p in ser if p[0] >= cutoff][-max_points:]
    hist["updatedAt"] = latest["generatedAt"]
    return hist


def fingerprint(latest: dict) -> str:
    """Everything except fetch/attempt times, so we only commit when values change."""
    def strip(o):
        if isinstance(o, dict):
            return {k: strip(v) for k, v in o.items() if k not in ("fetchedAt", "lastAttempt", "generatedAt")}
        if isinstance(o, list):
            return [strip(v) for v in o]
        return o
    return json.dumps(strip(latest), sort_keys=True)


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", default=None)
    a = ap.parse_args()
    prev_dir = a.prev or a.out
    prev = load(os.path.join(prev_dir, "latest.json"))
    prev_hist = load(os.path.join(prev_dir, "history.json"))
    latest = scrape(prev)
    changed = prev is None or fingerprint(prev) != fingerprint(latest)
    os.makedirs(a.out, exist_ok=True)
    hist = update_history(prev_hist, latest)
    with open(os.path.join(a.out, "latest.json"), "w", encoding="utf-8") as f:
        json.dump(latest, f, ensure_ascii=False, indent=1)
    with open(os.path.join(a.out, "history.json"), "w", encoding="utf-8") as f:
        json.dump(hist, f, separators=(",", ":"))
    summary = {k: ("ok" if v["ok"] else "FAIL " + v.get("error", "")) for k, v in latest["sources"].items()}
    print(json.dumps(summary, indent=1))
    print("CHANGED" if changed else "UNCHANGED")
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out:
        with open(gh_out, "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")


if __name__ == "__main__":
    sys.exit(main())
