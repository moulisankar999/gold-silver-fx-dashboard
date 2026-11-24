"""Tests for the automatic tax check. Run: python3 tests/test_taxcheck.py"""
import copy
import json
import os
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "scraper"))
import taxcheck as T  # noqa: E402

BASE = json.load(open(os.path.join(os.path.dirname(__file__), "..", "config", "taxes.json"), encoding="utf-8"))
NOW = datetime(2026, 11, 24, 10, 0, tzinfo=timezone.utc)

BCD_NOTICE = """[TO BE PUBLISHED IN THE GAZETTE OF INDIA, EXTRAORDINARY, PART II, SECTION 3, SUB-SECTION (i)]
GOVERNMENT OF INDIA MINISTRY OF FINANCE (DEPARTMENT OF REVENUE)
Notification No. 40/2026-Customs   New Delhi, the 1st December, 2026
G.S.R....(E).- In exercise of the powers conferred by sub-section (1) of section 25 of the Customs Act, 1962,
the Central Government hereby makes the following further amendments in the notification of the Government
of India, Ministry of Finance (Department of Revenue), No. 50/2017-Customs, dated the 30th June, 2017, namely:-
In the said notification, in the Table,
  356    7108        Gold bars, other than tola bars, bearing manufacturer's or refiner's       6%
  356A   7108 12 00  Gold dore bar having gold content not below 95%                           5.35%
  357    7106        Silver, including silver dore                                               6%
2. This notification shall come into force on the 2nd day of December, 2026.
""" + "x" * 200

AIDC_NOTICE = BCD_NOTICE.replace("50/2017-Customs", "11/2021-Customs").replace(
    "section 25 of the Customs Act, 1962", "section 124 of the Finance Act, 2021 (Agriculture Infrastructure and Development Cess)")

AMBIG = BCD_NOTICE.replace("Silver, including silver dore", "Silver bars 6% and silver grain 4%")


def test_rate_on_history():
    gold_bcd = BASE["metals"]["gold"]["levies"][0]
    assert T.rate_on(gold_bcd, "2026-05-12") == 0.05
    assert T.rate_on(gold_bcd, "2026-05-13") == 0.10
    assert T.current_rates(BASE, "2026-11-24") == {"gold": {"bcd": 0.10, "aidc": 0.05, "gst": 0.03},
                                                    "silver": {"bcd": 0.10, "aidc": 0.05, "gst": 0.03}}


def test_parse_bcd_cut():
    ch, prob = T.parse_notice(BCD_NOTICE, "customs", "40/2026-Customs", "2026-12-01", "u")
    assert prob is None
    assert {(c["metal"], c["levy"], c["to"], c["effective"]) for c in ch} == {
        ("gold", "bcd", 0.06, "2026-12-02"), ("silver", "bcd", 0.06, "2026-12-02")}


def test_parse_aidc():
    ch, prob = T.parse_notice(AIDC_NOTICE, "customs", "41/2026-Customs", "2026-12-01", "u")
    assert prob is None and all(c["levy"] == "aidc" for c in ch)


def test_ambiguous_and_scanned_are_only_possible():
    ch, prob = T.parse_notice(AMBIG, "customs", "40/2026-Customs", "2026-12-01", "u")
    assert ch == [] and "several rates" in prob
    ch, prob = T.parse_notice("   ", "customs", "x", "2026-12-01", "u")
    assert ch == [] and "scanned" in prob
    ch, prob = T.parse_notice("Notification about edible oils and steel " + "y" * 300, "customs", "x", "2026-12-01", "u")
    assert ch == [] and prob is None


def test_new_cess_becomes_its_own_levy():
    txt = BCD_NOTICE.replace("section 25 of the Customs Act, 1962", "section 8 of the Finance Act, 2026, the Precious Metals Security Cess")
    ch, prob = T.parse_notice(txt, "customs", "42/2026-Customs", "2026-12-01", "u")
    assert prob is None and ch[0]["name"] == "Precious Metals Security Cess" and ch[0]["base"] == "value"
    t = copy.deepcopy(BASE)
    assert T.apply_change(t, ch[0])
    ids = [l["id"] for l in t["metals"]["gold"]["levies"]]
    assert ids[-1] == "gst" and ch[0]["levy"] in ids   # new levy sits before GST
    assert not T.apply_change(t, ch[0])                 # idempotent


def test_check_end_to_end_with_fakes():
    t = copy.deepcopy(BASE)
    items = {"customs": [{"id": 1, "notificationNo": "40/2026-Customs", "notificationName": "Seeks to reduce BCD on gold and silver",
                          "updatedDate": "01-Dec-2026", "updateCategory": "Tariff", "docFilePath": "a\\b.pdf"},
                         {"id": 2, "notificationNo": "99/2026-Customs (NT)", "notificationName": "Fixation of Tariff Value of Gold and Silver",
                          "updatedDate": "01-Dec-2026"}],
             "gst": []}
    fake = {"cbic": lambda tax: items[tax], "notice": lambda it: BCD_NOTICE, "news": lambda q: ""}
    T.check(t, NOW, fake)
    assert T.current_rates(t, "2026-12-02")["gold"]["bcd"] == 0.06
    assert T.current_rates(t, "2026-12-01")["gold"]["bcd"] == 0.10
    assert len(t["changes"]) == 2 and t["changes"][0]["from"] == 0.10 and t["alerts"] == []
    assert "cbic:2" in t["seen"]
    # Second run: already seen, nothing new.
    T.check(t, NOW, fake)
    assert len(t["changes"]) == 2


def test_unclear_official_and_news_open_amber_alerts():
    t = copy.deepcopy(BASE)
    items = {"customs": [{"id": 7, "notificationNo": "43/2026-Customs", "notificationName": "Amendment for gold and silver",
                          "updatedDate": "01-Dec-2026"}], "gst": []}
    rss = ("<rss><channel><item><title>Govt cuts gold import duty to 6% from 15%</title><link>https://n.example/a</link>"
           "<pubDate>Tue, 24 Nov 2026 06:00:00 GMT</pubDate></item>"
           "<item><title>Gold imports fall 40% after duty hike</title><link>x</link><pubDate>Tue, 24 Nov 2026 06:00:00 GMT</pubDate></item>"
           "<item><title>Govt cuts gold import duty to 6%</title><link>x</link><pubDate>Mon, 02 Nov 2026 06:00:00 GMT</pubDate></item>"
           "</channel></rss>")
    fake = {"cbic": lambda tax: items[tax], "notice": lambda it: "", "news": lambda q: rss}
    T.check(t, NOW, fake)
    kinds = sorted(a["kind"] for a in t["alerts"])
    assert kinds == ["news", "official"], t["alerts"]
    assert T.current_rates(t, "2026-12-02") == T.current_rates(BASE, "2026-12-02")   # rates kept
    assert all(a["status"] == "open" for a in t["alerts"])


def test_merge_baseline_keeps_detected_history():
    t = copy.deepcopy(BASE)
    T.apply_change(t, {"metal": "gold", "levy": "bcd", "to": 0.06, "effective": "2026-12-02"})
    m = T.merge_baseline(t, BASE)
    assert T.rate_on(m["metals"]["gold"]["levies"][0], "2026-12-03") == 0.06


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v(); print("ok", k)
