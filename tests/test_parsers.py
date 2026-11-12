"""Parser tests against saved pages (12 Nov 2026). Run: python -m pytest tests -q  (or python tests/test_parsers.py)"""
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scraper"))
import scrape  # noqa: E402

F = os.path.join(os.path.dirname(__file__), "fixtures")
read = lambda n: open(os.path.join(F, n), encoding="utf-8", errors="ignore").read()  # noqa: E731


def test_mjdta():
    d = scrape.parse_mjdta(read("mjdta.html"))
    assert d["values"] == {"g22": 12815.0, "g18": 10490.0, "g14": 8400.0, "silver_g": 200.0}
    assert d["diff"]["g22"] == -200.0
    assert d["updatedAt"] == "2026-11-12T09:38:00+05:30"
    assert d["session"] == "Morning"


def test_cwja():
    d = scrape.parse_cwja(read("cwja.html"))
    assert d["values"]["g22"] == 12815.0 and d["values"]["silver_g"] == 200.0
    assert d["updatedAt"] == "2026-11-12T09:38:52+05:30"


def test_ibja():
    d = scrape.parse_ibja(read("ibja.html"), today_ist=datetime(2026, 11, 12, 14, 0, tzinfo=scrape.IST))
    assert d["date"] == "2026-11-12"
    assert d["am"]["g999"] == 138294.0 and d["am"]["s999"] == 181999.0
    assert d["pm"] is None
    assert d["history"]["am"][0] == {"date": "2026-11-11", "g999": 140805.0, "g995": 140241.0, "g916": 128977.0,
                                     "g750": 105604.0, "g585": 82371.0, "s999": 186495.0, "p999": 56300.0}
    assert d["history"]["pm"][0]["date"] == "2026-11-11"


def test_mcx():
    g = scrape.parse_mcxlive(read("mcx_gold.html"))
    assert g["contract"] == "04 Dec 2026" and g["expiry"] == "2026-12-04"
    assert g["ltp"] == 137650.0 and g["change"] == -2066.0 and g["changePct"] == -1.48
    assert g["lastTrade"] == "2026-11-12T14:28:00+05:30" and g["marketStatus"] == "Open"
    s = scrape.parse_mcxlive(read("mcx_silver.html"))
    assert s["ltp"] == 180828.0 and s["open"] == 184525.0


def test_history_dedupe():
    latest = {"generatedAt": "2026-11-12T09:00:00Z", "sources": {
        "spot_xau": {"ok": True, "data": {"usdPerOz": 4000.0, "updatedAt": "2026-11-12T09:00:00Z"}}}}
    h = scrape.update_history(None, latest)
    h = scrape.update_history(h, latest)
    assert len(h["series"]["spot_xau"]) == 1


def test_failure_keeps_last_good():
    prev = {"ok": True, "data": {"x": 1}, "fetchedAt": "2026-11-12T08:00:00Z"}
    out = scrape.run_source(prev, lambda: (_ for _ in ()).throw(RuntimeError("boom")), "u", "L", tries=1)
    assert out["ok"] is False and out["data"] == {"x": 1} and "boom" in out["error"]
    assert out["fetchedAt"] == "2026-11-12T08:00:00Z"


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v(); print("ok", k)
