#!/usr/bin/env python3
"""Keep data/taxes.json (every levy on gold and silver) up to date by itself.

Checks, at most every --min-hours:
  1. Official: CBIC tax portal latest Customs and GST notifications (taxinformation.cbic.gov.in).
     A notice about gold/silver (HS 7108/7106), AIDC, a new cess/surcharge or a GST rate change is
     downloaded and read. If the levy, metal, rate and effective date are all read cleanly, the rate is
     changed in taxes.json (new history entry) and a "changes" record drives a green banner.
  2. News: Google News RSS for gold/silver import duty / GST. News never changes a rate; a fresh
     headline that looks like a change opens an amber "possible tax change - checking" alert.
Anything detected but not read cleanly keeps the current rates, opens an amber alert and a GitHub issue.

Usage: python scraper/taxcheck.py --out DIR [--prev DIR] [--force] [--min-hours 6] [--offline]
Prints CHANGED when taxes.json content changed (the loop then publishes the data branch).
"""
from __future__ import annotations

import argparse
import base64
import copy
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import requests

UTC = timezone.utc
IST = timezone(timedelta(hours=5, minutes=30))
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
HERE = os.path.dirname(os.path.abspath(__file__))
BASELINE = os.path.join(HERE, "..", "config", "taxes.json")
CBIC = "https://taxinformation.cbic.gov.in/api/cbic-notification-msts"
CBIC_TAX = {"customs": 1000002, "gst": 1000001}
NEWS_QUERIES = ['"gold import duty"', '"silver import duty"', '"customs duty" gold', 'GST gold rate change', 'AIDC gold']
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july",
                                       "august", "september", "october", "november", "december"], 1)}
METAL_HS = {"gold": "7108", "silver": "7106"}


def now_utc() -> datetime:
    return datetime.now(UTC).replace(microsecond=0)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


# ------------------------------------------------------------------ rates
def rate_on(levy: dict, day: str) -> float | None:
    """Rate in force on ISO date `day` (latest history entry with from <= day)."""
    best = None
    for h in sorted(levy.get("history", []), key=lambda h: h["from"]):
        if h["from"] <= day:
            best = h["rate"]
    return best


def current_rates(taxes: dict, day: str) -> dict:
    return {m: {l["id"]: rate_on(l, day) for l in v["levies"]} for m, v in taxes["metals"].items()}


def apply_change(taxes: dict, ch: dict) -> bool:
    """Add a history entry (and the levy itself if new). Returns True if anything changed."""
    metal = taxes["metals"][ch["metal"]]
    lv = next((l for l in metal["levies"] if l["id"] == ch["levy"]), None)
    if lv is None:
        lv = {"id": ch["levy"], "name": ch.get("name") or ch["levy"].upper(), "short": ch.get("short") or ch["levy"].upper(),
              "group": ch.get("group", "duty"), "base": ch.get("base", "value"), "history": []}
        gi = [i for i, l in enumerate(metal["levies"]) if l["group"] == "gst"]
        metal["levies"].insert(gi[0] if gi and lv["group"] != "gst" else len(metal["levies"]), lv)
    if any(h["from"] == ch["effective"] and abs(h["rate"] - ch["to"]) < 1e-9 for h in lv["history"]):
        return False
    lv["history"] = [h for h in lv["history"] if h["from"] != ch["effective"]]
    lv["history"].append({"from": ch["effective"], "rate": ch["to"], "ref": ch.get("ref", ""), "url": ch.get("url", "")})
    lv["history"].sort(key=lambda h: h["from"])
    return True


# ------------------------------------------------------------------ official notices
RELEVANT_TITLE = re.compile(r"gold|silver|precious metal|bullion|dor[eé]\b|7108|7106|jewell?ery|"
                            r"agriculture infrastructure|aidc|social welfare surcharge|\bcess\b|50/2017|11/2021", re.I)
IGNORE_TITLE = re.compile(r"tariff value", re.I)  # fortnightly valuation notices, not rate changes


def notice_needs_reading(item: dict, tax: str) -> bool:
    name = f"{item.get('notificationName', '')} {item.get('notificationNo', '')}"
    if IGNORE_TITLE.search(name):
        return False
    if RELEVANT_TITLE.search(name):
        return True
    # GST rate notifications rarely name gold in the title; read every "(Rate)" one.
    return tax == "gst" and "rate" in (item.get("updateCategory", "") + item.get("notificationNo", "")).lower()


def mentions_metal(text: str) -> list[str]:
    t = text.lower()
    out = []
    for m, hs in METAL_HS.items():
        if re.search(rf"\b{hs}\b", t) or re.search(rf"\b{m}\b", t):
            out.append(m)
    return out


def _pct(s: str) -> float | None:
    m = re.search(r"(\d{1,2}(?:\.\d{1,2})?)\s*(?:%|per\s*cent)", s, re.I)
    return float(m.group(1)) / 100 if m else None


def parse_effective(text: str, fallback: str) -> str:
    t = re.sub(r"\s+", " ", text)
    m = re.search(r"(?:come into force|with effect from|w\.e\.f\.?)\s*(?:on|from)?\s*(?:the)?\s*(\d{1,2})(?:st|nd|rd|th)?\s*(?:day of)?\s*"
                  r"(january|february|march|april|may|june|july|august|september|october|november|december),?\s*(\d{4})", t, re.I)
    if m:
        return f"{int(m.group(3)):04d}-{MONTHS[m.group(2).lower()]:02d}-{int(m.group(1)):02d}"
    m = re.search(r"(?:come into force|with effect from)\s*(?:on|from)?\s*(?:the)?\s*(\d{1,2})[./-](\d{1,2})[./-](\d{4})", t, re.I)
    if m:
        return f"{int(m.group(3)):04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return fallback


def identify_levy(text: str, tax: str) -> dict | None:
    t = re.sub(r"\s+", " ", text)
    if tax == "gst" or re.search(r"integrated tax \(rate\)|central tax \(rate\)", t, re.I):
        return {"levy": "gst", "group": "gst", "base": "cumulative"}
    if re.search(r"agriculture infrastructure and development cess", t, re.I):
        return {"levy": "aidc", "group": "duty", "base": "value"}
    if re.search(r"social welfare surcharge", t, re.I):
        return {"levy": "sws", "name": "Social Welfare Surcharge", "short": "SWS", "group": "duty", "base": "duty"}
    m = re.search(r"\b((?:[A-Z][a-z]+ ){1,6}(?:Cess|Surcharge))\b", t)
    if m and "Agriculture" not in m.group(1):
        name = m.group(1).strip()
        short = "".join(w[0] for w in name.split() if w[0].isupper())
        return {"levy": re.sub(r"[^a-z]", "", short.lower()) or "cess", "name": name, "short": short, "group": "duty", "base": "value"}
    if re.search(r"customs tariff|first schedule to the customs tariff act|50/2017-customs|section 25 of the customs act", t, re.I):
        return {"levy": "bcd", "group": "duty", "base": "value"}
    return None


def rates_for_metal(text: str, metal: str) -> list[float]:
    """Rates written on the same table row as the metal's heading (7108 / 7106)."""
    hs = METAL_HS[metal]
    found = []
    for line in text.splitlines():
        if re.search(rf"\b{hs}\b|\b{metal}\b", line, re.I):
            if re.search(r"dor[eé]|\bores?\b|concentrate|scrap|waste|coin|medallion|jewell?ery|findings|plated|clad", line, re.I) \
                    and not re.search(r"including", line, re.I):
                continue
            found += [float(x) / 100 for x in re.findall(r"(\d{1,2}(?:\.\d{1,2})?)\s*(?:%|per\s*cent)", line, re.I)]
    return sorted(set(found))


def parse_notice(text: str, tax: str, notif_no: str, notif_date: str, url: str) -> tuple[list[dict], str | None]:
    """Return (changes, problem). changes are confident; problem explains why it is only 'possible'."""
    if len(text.strip()) < 200:
        return [], "the notice is a scanned image, so it could not be read automatically"
    metals = mentions_metal(text)
    if not metals:
        return [], None  # not about gold/silver at all
    lv = identify_levy(text, tax)
    if not lv:
        return [], "it mentions gold/silver but the levy could not be identified"
    eff = parse_effective(text, notif_date)
    out = []
    for m in metals:
        rs = rates_for_metal(text, m)
        if len(rs) != 1:
            return [], f"{m}: {'no rate' if not rs else 'several rates ' + ', '.join(f'{r*100:g}%' for r in rs)} found next to heading {METAL_HS[m]}"
        if not (0 <= rs[0] <= 0.5):
            return [], f"{m}: rate {rs[0]*100:g}% is outside the expected range"
        out.append({**lv, "metal": m, "to": rs[0], "effective": eff, "ref": f"Notification {notif_no}", "url": url})
    return out, None


def http_get(url: str, **kw) -> requests.Response:
    kw.setdefault("timeout", 40)
    kw.setdefault("headers", {"User-Agent": UA, "Accept": "application/json, text/plain, */*"})
    try:
        return requests.get(url, **kw)
    except requests.exceptions.SSLError:
        # Several gov.in hosts serve an incomplete certificate chain. Read-only public data; retry unverified.
        import urllib3
        urllib3.disable_warnings()
        return requests.get(url, verify=False, **kw)


def pdf_text(pdf: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(pdf); f.flush()
        try:
            return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, timeout=60).stdout.decode("utf-8", "ignore")
        except Exception:
            return ""


def fetch_cbic(tax: str) -> list[dict]:
    r = http_get(f"{CBIC}/fetchUpdatesByTaxId/{CBIC_TAX[tax]}")
    r.raise_for_status()
    return r.json()


def cbic_date(s: str) -> str:
    try:
        return datetime.strptime(s, "%d-%b-%Y").strftime("%Y-%m-%d")
    except Exception:
        return now_utc().astimezone(IST).strftime("%Y-%m-%d")


def notice_url(item: dict) -> str:
    p = (item.get("docFilePath") or "").replace("\\", "/")
    return f"https://taxinformation.cbic.gov.in/view-pdf/{p}" if p else "https://taxinformation.cbic.gov.in/"


def read_notice(item: dict) -> str:
    r = http_get(f"{CBIC}/download/{item['id']}/ENG")
    r.raise_for_status()
    data = r.json().get("data") or ""
    return pdf_text(base64.b64decode(data)) if data else ""


# ------------------------------------------------------------------ news
NEWS_SUBJECT = re.compile(r"\b(gold|silver|bullion)\b", re.I)
NEWS_TAX = re.compile(r"import duty|customs duty|\bduty\b|\bgst\b|\bcess\b|\baidc\b", re.I)
NEWS_ACTION = re.compile(r"\b(cuts?|slash(?:es|ed)?|hikes?|hiked|raises?|raised|reduces?|reduced|lowers?|lowered|"
                         r"increases?|increased|revises?|revised|imposes?|imposed|scraps?|scrapped|notif(?:y|ies|ied))\b", re.I)
NEWS_WHO = re.compile(r"\b(govt|government|centre|center|budget|cbic|finance ministry|fm|sitharaman|notif\w*|india)\b", re.I)
NEWS_NUMBER = re.compile(r"\d+(?:\.\d+)?\s*(?:%|per\s*cent)", re.I)
NEWS_PAST = re.compile(r"\b(after|since|despite|following|amid|impact|effect of|due to)\b", re.I)


def news_candidates(rss: str, now: datetime, max_age_h: float = 48) -> list[dict]:
    out = []
    for item in re.findall(r"<item>(.*?)</item>", rss, re.S):
        t = re.search(r"<title>(.*?)</title>", item, re.S)
        l = re.search(r"<link>(.*?)</link>", item, re.S)
        d = re.search(r"<pubDate>(.*?)</pubDate>", item, re.S)
        if not (t and d):
            continue
        title = re.sub(r"<!\[CDATA\[|\]\]>", "", t.group(1)).replace("&amp;", "&").replace("&#39;", "'").strip()
        try:
            pub = parsedate_to_datetime(d.group(1).strip())
        except Exception:
            continue
        if (now - pub).total_seconds() > max_age_h * 3600:
            continue
        if (NEWS_SUBJECT.search(title) and NEWS_TAX.search(title) and NEWS_ACTION.search(title)
                and NEWS_WHO.search(title) and NEWS_NUMBER.search(title) and not NEWS_PAST.search(title)):
            out.append({"title": title, "url": (l.group(1).strip() if l else ""), "published": iso(pub)})
    return out


# ------------------------------------------------------------------ github issue
def open_issue(title: str, body: str) -> int | None:
    tok, repo = os.environ.get("GH_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not tok or not repo:
        return None
    try:
        r = requests.post(f"https://api.github.com/repos/{repo}/issues", timeout=30,
                          headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"},
                          json={"title": title, "body": body, "labels": ["tax-check"]})
        return r.json().get("number") if r.ok else None
    except Exception:
        return None


def issue_closed(num: int) -> bool:
    tok, repo = os.environ.get("GH_TOKEN"), os.environ.get("GITHUB_REPOSITORY")
    if not tok or not repo or not num:
        return False
    try:
        r = requests.get(f"https://api.github.com/repos/{repo}/issues/{num}", timeout=30,
                         headers={"Authorization": f"Bearer {tok}", "Accept": "application/vnd.github+json"})
        return r.ok and r.json().get("state") == "closed"
    except Exception:
        return False


# ------------------------------------------------------------------ main check
def add_alert(taxes: dict, key: str, kind: str, title: str, detail: str, url: str, now: datetime):
    if any(a["key"] == key for a in taxes["alerts"]):
        return
    num = open_issue(f"Possible gold/silver tax change: {title[:90]}",
                     f"The automatic tax check found something it could not apply by itself.\n\n"
                     f"- **What:** {title}\n- **Why not applied:** {detail}\n- **Source ({kind}):** {url}\n\n"
                     f"Current rates are kept until this is checked. If a rate really changed, edit `config/taxes.json` "
                     f"(add a history entry) and close this issue; the amber banner clears when the issue is closed.")
    taxes["alerts"].append({"key": key, "status": "open", "kind": kind, "title": title, "detail": detail, "url": url,
                            "detectedAt": iso(now), "issue": num})


def check(taxes: dict, now: datetime, fetch=None) -> list[str]:
    """Run every source. `fetch` lets tests inject fake sources. Returns a log."""
    fetch = fetch or {"cbic": fetch_cbic, "notice": read_notice,
                      "news": lambda q: http_get("https://news.google.com/rss/search", params={"q": q + " when:3d", "hl": "en-IN", "gl": "IN", "ceid": "IN:en"}).text}
    log, seen = [], set(taxes.get("seen", []))
    applied_any = False
    for tax in ("customs", "gst"):
        try:
            items = fetch["cbic"](tax)
        except Exception as e:  # noqa: BLE001
            log.append(f"cbic {tax}: failed {e}")
            continue
        for it in items:
            key = f"cbic:{it.get('id')}"
            if key in seen:
                continue
            seen.add(key)
            if not notice_needs_reading(it, tax):
                continue
            no, day, url = it.get("notificationNo", ""), cbic_date(it.get("updatedDate", "")), notice_url(it)
            try:
                text = fetch["notice"](it)
            except Exception as e:  # noqa: BLE001
                text, err = "", e
            changes, problem = parse_notice(text, tax, no, day, url)
            log.append(f"cbic {no}: {len(changes)} change(s){' / ' + problem if problem else ''}")
            for ch in changes:
                old = rate_on(next((l for l in taxes["metals"][ch["metal"]]["levies"] if l["id"] == ch["levy"]), {"history": []}), ch["effective"])
                if apply_change(taxes, ch):
                    applied_any = True
                    lv = next(l for l in taxes["metals"][ch["metal"]]["levies"] if l["id"] == ch["levy"])
                    taxes["changes"].append({"metal": ch["metal"], "levy": ch["levy"], "name": lv["name"], "short": lv["short"],
                                             "from": old, "to": ch["to"], "effective": ch["effective"], "ref": ch["ref"],
                                             "url": url, "detectedAt": iso(now)})
            if problem and RELEVANT_TITLE.search(it.get("notificationName", "") + " " + text[:4000]):
                add_alert(taxes, key, "official", f"{no}: {it.get('notificationName', '')}"[:200], problem, url, now)
    for q in NEWS_QUERIES:
        try:
            for c in news_candidates(fetch["news"](q), now):
                key = "news:" + re.sub(r"\W+", "", c["title"].lower())[:80]
                if key in seen:
                    continue
                seen.add(key)
                if applied_any:
                    continue
                log.append(f"news: {c['title']}")
                add_alert(taxes, key, "news", c["title"], "news headline only; waiting for an official notification", c["url"], now)
        except Exception as e:  # noqa: BLE001
            log.append(f"news {q}: failed {e}")
    # Close alerts: issue closed, or 7 days with nothing official. Drop change banners after 30 days.
    for a in taxes["alerts"]:
        if a["status"] == "open" and (issue_closed(a.get("issue")) or now - datetime.fromisoformat(a["detectedAt"].replace("Z", "+00:00")) > timedelta(days=7)):
            a["status"] = "closed"
    cutoff = now - timedelta(days=60)
    taxes["alerts"] = [a for a in taxes["alerts"] if datetime.fromisoformat(a["detectedAt"].replace("Z", "+00:00")) > cutoff]
    taxes["seen"] = sorted(seen)[-400:]
    return log


def load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def merge_baseline(prev: dict | None, base: dict) -> dict:
    """Start from the published file but let edits to config/taxes.json (manual fixes) win."""
    if not prev:
        return copy.deepcopy(base)
    out = copy.deepcopy(prev)
    for m, mv in base["metals"].items():
        pm = out["metals"].setdefault(m, copy.deepcopy(mv))
        for bl in mv["levies"]:
            pl = next((l for l in pm["levies"] if l["id"] == bl["id"]), None)
            if pl is None:
                pm["levies"].append(copy.deepcopy(bl)); continue
            for k in ("name", "short", "group", "base"):
                pl[k] = bl[k]
            have = {h["from"] for h in bl["history"]}
            pl["history"] = sorted(copy.deepcopy(bl["history"]) + [h for h in pl["history"] if h["from"] not in have], key=lambda h: h["from"])
    out["sources"] = base.get("sources", out.get("sources", []))
    out["about"] = base.get("about", "")
    for k in ("changes", "alerts", "seen"):
        out.setdefault(k, [])
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", default=None)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--offline", action="store_true")
    ap.add_argument("--min-hours", type=float, default=6)
    a = ap.parse_args()
    base = load(BASELINE)
    prev = load(os.path.join(a.prev, "taxes.json")) if a.prev else None
    taxes = merge_baseline(prev, base)
    before = json.dumps({k: v for k, v in taxes.items() if k not in ("checkedAt", "updatedAt")}, sort_keys=True)
    now = now_utc()
    last = taxes.get("checkedAt")
    due = a.force or not last or now - datetime.fromisoformat(last.replace("Z", "+00:00")) >= timedelta(hours=a.min_hours)
    if due and not a.offline:
        for line in check(taxes, now):
            print("tax:", line)
        taxes["checkedAt"] = iso(now)
    after = json.dumps({k: v for k, v in taxes.items() if k not in ("checkedAt", "updatedAt")}, sort_keys=True)
    changed = before != after or (prev or {}).get("checkedAt") != taxes.get("checkedAt") or not prev
    if before != after:
        taxes["updatedAt"] = iso(now)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "taxes.json"), "w", encoding="utf-8") as f:
        json.dump(taxes, f, ensure_ascii=False, indent=1)
    rates = current_rates(taxes, now.astimezone(IST).strftime("%Y-%m-%d"))
    print("tax rates:", json.dumps(rates))
    if changed:
        print("CHANGED taxes")


if __name__ == "__main__":
    main()
