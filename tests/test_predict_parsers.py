"""Parser tests against saved pages (21 Nov 2026). Run: python3 tests/test_parsers.py"""
import os
import sys
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scraper"))
import predict_scrape as scrape  # noqa: E402

F = os.path.join(os.path.dirname(__file__), "fixtures", "predict")
rd = lambda n: open(os.path.join(F, n), encoding="utf-8").read()


def test_mcx():
    d = scrape.parse_mcxlive(rd("mcx_gold.html"))
    assert d["value"] == 121949 and d["expiry"] == "2026-12-04", d
    assert d["t"] == "2026-11-20T18:24:00Z"
    assert d["prevClose"] == 127548  # previous daily close, not FD_FEED.close
    # intra times are IST wall clock in the feed; parser shifts them to real UTC (MCX closes 23:55 IST = 18:25 UTC)
    last = d["intra"][-1][0]
    assert abs(last - 1795218968 + 19800) < 1


def test_ibja_pdf():
    rows = scrape.parse_ibja_pdf_text(rd("ibja30.txt"))
    r = {(x["date"], x["sess"]): x for x in rows}
    assert r[("2026-11-20", "AM")]["g999"] == 123584 and r[("2026-11-20", "PM")]["s999"] == 152528
    assert r[("2026-11-20", "AM")]["g916"] == 113203
    assert ("2026-11-10", "PM") not in r and ("2026-11-10", "AM") in r  # '-' = no PM print


def test_ibja_home():
    d = scrape.parse_ibja_home(rd("ibja_home.html"), today=date(2026, 11, 21))
    assert d["pdf"] and "30DaysPdf" in d["pdf"]


def test_mjdta():
    d = scrape.parse_mjdta(rd("mjdta.html"))
    assert d["g22"] == 11465 and d["silver_g"] == 175 and d["date"] == "2026-11-21" and d["session"] == "Morning"


def test_goodreturns():
    g = scrape.parse_goodreturns(rd("gr_gold.html"), "gold")
    assert g[0] == {"date": "2026-11-21", "g24": 12508, "g22": 11465}, g[0]
    s = scrape.parse_goodreturns(rd("gr_silver.html"), "silver")
    assert s[0]["date"] == "2026-11-21" and s[0]["silver_g"] == 175


def test_series():
    s = scrape.Series([[100, 1.0], [200, 2.0]])
    assert s.value_at(150) == 1.0 and s.value_at(50) is None and s.value_at(200 + 5 * 3600) is None


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
