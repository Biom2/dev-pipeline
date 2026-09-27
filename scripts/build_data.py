#!/usr/bin/env python3
"""Daily data refresh for the Masdar development pipeline site.

Downloads the BPD project summary CSV, archives a dated snapshot when the
content changed, harmonises the values and writes the JSON files the static
site reads:

    site/data/latest.json            current projects (raw + harmonised + flags)
    site/data/changes.json           day-over-day differences between snapshots
    site/data/history/index.json     list of archived snapshots + time of the last successful check
    site/data/history/<date>.csv     raw CSV as received that day

Usage:
    CSV_URL=... python scripts/build_data.py          # fetch from Azure Blob
    python scripts/build_data.py --file export.csv    # use a local file
    python scripts/build_data.py --rebuild            # only re-derive JSON from the archive

Standard library only, so the GitHub Action needs no pip install.
"""

import argparse
import csv
import hashlib
import io
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
DATA = ROOT / "site" / "data"
HISTORY = DATA / "history"

# Columns that change on every ingest without the data changing.
VOLATILE_COLUMNS = {"ingested_at"}

# Label and group for every source column, in display order. Columns that
# appear in the CSV but not here are still shown, under "Other".
COLUMNS = [
    ("project_name", "Project name", "Identity"),
    ("project_manager", "Project manager", "Identity"),
    ("stage", "Stage", "Status"),
    ("substage", "Sub-stage", "Status"),
    ("transaction_type", "Transaction type", "Identity"),
    ("technology", "Technology", "Technical"),
    ("region", "Region", "Location"),
    ("country", "Country", "Location"),
    ("latitude", "Latitude", "Location"),
    ("longitude", "Longitude", "Location"),
    ("capacity_ac_mw", "Capacity AC (MW)", "Technical"),
    ("capacity_dc_mw", "Capacity DC (MWp)", "Technical"),
    ("bess_design_mwh", "BESS design (MWh)", "Technical"),
    ("bess_guaranteed_mwh", "BESS guaranteed (MWh)", "Technical"),
    ("offtake_type", "Offtake", "Commercial"),
    ("offtake_term_years", "Offtake term (years)", "Commercial"),
    ("tariff_per_kwh", "Tariff per kWh", "Commercial"),
    ("epc_contractor", "EPC contractor", "Status"),
    ("project_life_years", "Project life (years)", "Commercial"),
    ("shareholders", "Shareholders", "Financing"),
    ("funding_plan", "Funding plan", "Financing"),
    ("approved_budget", "Approved budget", "Financing"),
    ("approved_budget_note", "Approved budget note", "Financing"),
    ("project_value_usdm", "Project value (USD m)", "Financing"),
    ("parse_error", "Parse error", "Source"),
    ("ingested_at", "Ingested at", "Source"),
    ("capacity_ac_mw_num", "Capacity AC (MW) — source numeric", "Source numeric"),
    ("capacity_dc_mw_num", "Capacity DC (MWp) — source numeric", "Source numeric"),
    ("bess_design_mwh_num", "BESS design (MWh) — source numeric", "Source numeric"),
    ("bess_guaranteed_mwh_num", "BESS guaranteed (MWh) — source numeric", "Source numeric"),
    ("offtake_term_years_num", "Offtake term — source numeric", "Source numeric"),
    ("tariff_per_kwh_num", "Tariff — source numeric", "Source numeric"),
    ("project_life_years_num", "Project life — source numeric", "Source numeric"),
    ("approved_budget_num", "Approved budget — source numeric", "Source numeric"),
    ("project_value_usdm_num", "Project value — source numeric", "Source numeric"),
]

ZERO_WIDTH = re.compile(r"[​‌‍⁠﻿]")
NUM = r"\d[\d,]*(?:\.\d+)?"


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def clean(text):
    """Trim, drop zero-width characters and collapse whitespace."""
    if text is None:
        return ""
    text = ZERO_WIDTH.sub("", str(text))
    return re.sub(r"\s+", " ", text).strip()


def key(text):
    """Lookup key for the mapping tables: lower case, unified dashes and spaces."""
    text = clean(text).lower().replace("–", "-").replace("—", "-")
    return re.sub(r"\s+", " ", text).strip(" ,;/")


def fold(text):
    """Accent-insensitive key (Türkiye == Turkiye)."""
    return "".join(c for c in unicodedata.normalize("NFKD", key(text)) if not unicodedata.combining(c))


def slug(text):
    s = fold(text)
    s = re.sub(r"[^a-z0-9]+", "-", s).strip("-")
    return s or "project"


def to_float(text):
    try:
        return float(str(text).replace(",", ""))
    except (TypeError, ValueError):
        return None


def load_json(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except FileNotFoundError:
        return default


def write_json(path, obj):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(obj, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")


def now_utc():
    return datetime.now(timezone.utc).replace(microsecond=0)


# ---------------------------------------------------------------------------
# Source + archive
# ---------------------------------------------------------------------------

def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "masdar-dev-pipeline/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.read()
    except urllib.error.URLError as exc:
        # python.org builds on macOS ship without CA certificates; curl uses the system store.
        if not isinstance(getattr(exc, "reason", None), ssl.SSLCertVerificationError) or not shutil.which("curl"):
            raise
        return subprocess.run(["curl", "-fsSL", "--max-time", "60", url], check=True, capture_output=True).stdout


def parse_csv(raw_bytes):
    text = raw_bytes.decode("utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text)))
    if not rows:
        raise SystemExit("Source CSV is empty — refusing to overwrite the site data.")
    if "project_name" not in rows[0]:
        raise SystemExit("Source CSV has no 'project_name' column — format changed?")
    return rows


def content_hash(rows):
    """Hash of the data itself, ignoring columns that change on every ingest."""
    h = hashlib.sha256()
    for r in rows:
        h.update(json.dumps({k: clean(v) for k, v in r.items() if k not in VOLATILE_COLUMNS},
                            sort_keys=True, ensure_ascii=False).encode())
    return h.hexdigest()[:16]


def archive(raw_bytes, rows, today):
    """Store today's CSV if the data differs from the last snapshot. Returns (index, is_new)."""
    index = load_json(HISTORY / "index.json", {"snapshots": []})
    snaps = index["snapshots"]
    digest = content_hash(rows)
    ingested = max((clean(r.get("ingested_at")) for r in rows), default="")

    if snaps and snaps[-1]["hash"] == digest:
        return index, False

    name = f"{today}.csv"
    (HISTORY / name).write_bytes(raw_bytes)
    entry = {"date": today, "file": name, "hash": digest, "rows": len(rows), "source_ingested_at": ingested}
    # Several data changes on the same day keep only the latest one.
    snaps[:] = [s for s in snaps if s["date"] != today] + [entry]
    snaps.sort(key=lambda s: s["date"])
    write_json(HISTORY / "index.json", index)
    return index, True


# ---------------------------------------------------------------------------
# Harmonisation
# ---------------------------------------------------------------------------

class Harmoniser:
    def __init__(self):
        self.m = load_json(CONFIG / "mappings.json", {})
        self.centres = {k: v for k, v in load_json(CONFIG / "countries.json", {}).items() if not k.startswith("_")}
        self.placeholders = [p.lower() for p in self.m.get("placeholders", [])]
        self.na = set(self.m.get("not_available", []))

    # -- generic -------------------------------------------------------------

    def is_placeholder(self, text):
        k = key(text)
        return any(p in k for p in self.placeholders)

    def strip_placeholder(self, text):
        """Remove template hints like '(Only Number No Unit)' but keep what the user typed."""
        t = clean(text)
        for p in self.placeholders:
            t = re.sub(r"\(?\s*" + re.escape(p) + r"[^)]*\)?", "", t, flags=re.I)
        return clean(t)

    def value(self, text):
        """Human text with placeholders and 'N/A'-style values reduced to None."""
        t = self.strip_placeholder(text)
        if key(t) in self.na:
            return None
        return t or None

    def lookup(self, table, text, fallback=None):
        k = fold(text)
        for src, dst in self.m.get(table, {}).items():
            if fold(src) == k:
                return dst, True
        return (clean(text) if fallback is None else fallback), False

    # -- numbers -------------------------------------------------------------

    def mw(self, text):
        """Capacity in MW. '2 projects (1300 MW and 900 MW)' -> 2200."""
        t = self.value(text)
        if t is None:
            return None
        with_unit = re.findall(r"(" + NUM + r")\s*MW", t, flags=re.I)
        if len(with_unit) > 1:
            return sum(to_float(x) for x in with_unit)
        m = re.search(NUM, t)
        return to_float(m.group()) if m else None

    def usd_m(self, text):
        """Money in USD million. Handles '$661MM', '1.042 bn', '~ 2 Billion USD'."""
        t = self.value(text)
        if t is None or re.search(r"confidential|evaluation", t, re.I):
            return None
        m = re.search(NUM, t)
        if not m:
            return None
        v = to_float(m.group())
        if re.search(r"\b(bn|billion|b)\b", t[m.end():], re.I):
            v *= 1000
        return v

    def years(self, text):
        t = self.value(text)
        m = re.search(NUM, t or "")
        return to_float(m.group()) if m else None

    def tariff_cents(self, text):
        """Best-effort tariff in US cents/kWh. Values < 0.2 are read as USD/kWh,
        values between 1 and 20 as cents; anything else is left undetermined."""
        t = self.value(text)
        if t is None or re.search(r"confidential|evaluation", t, re.I):
            return None
        m = re.search(NUM, t)
        if not m:
            return None
        v = to_float(m.group())
        if v < 0.2:
            return round(v * 100, 3)
        if 1 <= v <= 20:
            return v
        return None

    # -- financing -----------------------------------------------------------

    @staticmethod
    def pct_range(text, word):
        """'Debt 75-80%' or '69% Debt' or 'Debt up to 80%' -> (75, 80)."""
        pat_after = word + r"[^%\d]{0,14}(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*%"
        pat_before = r"(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*%\s*" + word
        for pat in (pat_before, pat_after):  # '69% Debt, 31% Equity' must not read 31 as debt
            m = re.search(pat, text, re.I)
            if m:
                lo = float(m.group(1))
                hi = float(m.group(2)) if m.group(2) else lo
                return [lo, hi]
        return None

    def funding(self, text):
        t = clean(text)
        debt = self.pct_range(t, "debt") or self.pct_range(t, "gearing")
        equity = self.pct_range(t, "equity")
        if debt and not equity:
            equity = [100 - debt[1], 100 - debt[0]]
        if equity and not debt:
            debt = [100 - equity[1], 100 - equity[0]]
        lenders = None
        if "/" in t:
            tail = clean(t.split("/", 1)[1])
            lenders = tail or None
        return {"debt_pct": debt, "equity_pct": equity, "lenders": lenders}

    @staticmethod
    def masdar_share(text):
        t = clean(text)
        shares = [float(x) for x in re.findall(r"Masdar\s*(?:[-–:]\s*)?(?:min\.?\s*)?(\d+(?:\.\d+)?)\s*%", t, re.I)]
        if not shares:
            return None
        return [min(shares), max(shares)]

    @staticmethod
    def partners(text):
        """Names of the other shareholders, without percentages."""
        t = re.sub(r"\([^)]*\)", "", clean(text))
        t = re.sub(r"Pkg\s*[\d\s&]+-", ",", t, flags=re.I)  # 'Pkg 2 & 3 - Masdar 49%'
        parts = re.split(r",|&|\band\b|;", t)
        out = []
        for p in parts:
            name = clean(re.sub(r"[-–]?\s*(min\.?\s*)?\d+(\.\d+)?\s*%|\(.*", "", p, flags=re.I))
            if name and fold(name) != "masdar" and name not in out and not re.fullmatch(r"(tbd|not yet finalized)", name, re.I):
                out.append(name)
        return out

    def epc_status(self, text):
        t = self.value(text)
        if t is None:
            return "Not defined"
        k = key(t)
        if re.search(r"tender|procurement|not yet selected", k):
            return "Tendering"
        if re.search(r"shortlist|discussion|non binding|consortiums", k):
            return "Shortlisted / in discussion"
        return "Selected"

    @staticmethod
    def offtaker(text):
        t = clean(text)
        k = key(t)
        if re.search(r"govt|government|transco", k):
            kind = "Government"
        elif re.search(r"private", k):
            kind = "Private"
        elif k in ("tbc", "tbd", ""):
            kind = "Not defined"
        else:
            kind = "Other"
        name = None
        parts = re.split(r"\s[–-]\s?|–", t)
        if len(parts) > 1:
            name = clean(parts[-1])
            name = re.sub(r"^(govt\.? off-?taker\s*[–-]\s*)+", "", name, flags=re.I) or None
        return kind, name

    # -- one row -------------------------------------------------------------

    def row(self, raw, seen_ids):
        name = clean(raw.get("project_name"))
        flags = []

        def flag(level, field, message):
            flags.append({"level": level, "field": field, "message": message})

        for col, v in raw.items():
            if v and self.is_placeholder(v):
                flag("warn", col, f"Template instruction left in the field: “{clean(v)}”")
            if v and ZERO_WIDTH.search(v):
                flag("info", col, "Hidden zero-width characters removed")

        # Stage and sub-stage
        stage_raw = clean(raw.get("stage"))
        group, ok = self.lookup("stage", stage_raw, fallback="unmapped")
        if not ok:
            group = "unmapped"
            flag("bad", "stage", f"Unknown stage “{stage_raw}” — add it to config/mappings.json")
        stage_label, _ = self.lookup("stage_label", stage_raw)
        sub_raw = clean(raw.get("substage"))
        sub, ok = self.lookup("substage", sub_raw)
        if not ok and sub_raw:
            flag("warn", "substage", f"Unknown sub-stage “{sub_raw}”")
        if sub is None:
            flag("info", "substage", "Sub-stage not specified")

        # Technology (inferred from the name when the template text was left in)
        tech_raw = clean(raw.get("technology"))
        tech, ok = self.lookup("technology", tech_raw)
        if self.is_placeholder(tech_raw):
            guess = "Solar PV" if re.search(r"solar|pv", name, re.I) else ("Wind" if re.search(r"wind", name, re.I) else None)
            tech = guess or "Not specified"
            if guess:
                flag("warn", "technology", f"Technology missing — inferred “{guess}” from the project name")
        elif not ok:
            flag("info", "technology", f"Technology “{tech_raw}” kept as typed (not in mapping)")

        ttype, _ = self.lookup("transaction_type", re.sub(r"\s*\(.*\)", "", clean(raw.get("transaction_type"))))
        country, _ = self.lookup("country", raw.get("country"))
        region, _ = self.lookup("region", raw.get("region"))

        # Location — fall back to the country centre when coordinates are missing
        lat, lon = to_float(raw.get("latitude")), to_float(raw.get("longitude"))
        approx = False
        if lat is None or lon is None:
            centre = self.centres.get(country)
            if centre:
                lat, lon, approx = centre[0], centre[1], True
                flag("info", "latitude", "No coordinates — placed at the country centre")
            else:
                lat = lon = None
                flag("warn", "latitude", f"No coordinates and no centre known for “{country}”")

        # Numbers — recomputed from the raw text, compared with the source numeric columns
        ac = self.mw(raw.get("capacity_ac_mw"))
        dc = self.mw(raw.get("capacity_dc_mw"))
        bess_d = self.mw(raw.get("bess_design_mwh"))
        bess_g = self.mw(raw.get("bess_guaranteed_mwh"))
        value = self.usd_m(raw.get("project_value_usdm"))
        for col, mine in (("capacity_ac_mw", ac), ("capacity_dc_mw", dc), ("project_value_usdm", value)):
            src = to_float(raw.get(col + "_num"))
            if src is not None and mine is not None and abs(src - mine) > 0.01:
                flag("warn", col, f"Source numeric {src:g} differs from the text “{clean(raw.get(col))}” — using {mine:g}")
        if ac and dc and dc < ac * 0.95:
            flag("warn", "capacity_dc_mw", f"DC capacity ({dc:g}) lower than AC ({ac:g}) — please check")
        if ac is None:
            flag("bad", "capacity_ac_mw", "AC capacity missing")

        tariff_c = self.tariff_cents(raw.get("tariff_per_kwh"))
        tariff_raw = self.value(raw.get("tariff_per_kwh"))
        if tariff_raw and tariff_c is None and not re.search(r"confidential|evaluation", tariff_raw, re.I):
            flag("info", "tariff_per_kwh", f"Tariff unit unclear (“{tariff_raw}”) — not converted")

        fund = self.funding(raw.get("funding_plan"))
        if not fund["debt_pct"]:
            flag("info", "funding_plan", "Debt / equity split not stated")
        share = self.masdar_share(raw.get("shareholders"))
        off_kind, off_name = self.offtaker(raw.get("offtake_type"))

        pid = slug(name)
        while pid in seen_ids:
            pid += "-2"
        seen_ids.add(pid)

        return {
            "id": pid,
            "name": name,
            "raw": {k: clean(v) for k, v in raw.items()},
            "n": {
                "stage_group": group,
                "stage": stage_label,
                "substage": sub,
                "technology": tech,
                "transaction_type": ttype,
                "country": country,
                "region": region,
                "lat": lat, "lon": lon, "approx_location": approx,
                "ac_mw": ac, "dc_mw": dc,
                "bess_design_mwh": bess_d, "bess_guaranteed_mwh": bess_g,
                "has_bess": bool((bess_d or 0) > 0 or "bess" in key(tech)),
                "value_usdm": value,
                "tariff_usc_kwh": tariff_c,
                "offtake_kind": off_kind, "offtaker": off_name,
                "offtake_years": self.years(raw.get("offtake_term_years")),
                "life_years": self.years(raw.get("project_life_years")),
                "epc": self.value(raw.get("epc_contractor")),
                "epc_status": self.epc_status(raw.get("epc_contractor")),
                "debt_pct": fund["debt_pct"], "equity_pct": fund["equity_pct"], "lenders": fund["lenders"],
                "masdar_share_pct": share,
                "partners": self.partners(raw.get("shareholders")),
                "budget_usdm": to_float(raw.get("approved_budget_num")),
                "budget_note": self.value(raw.get("approved_budget_note")),
                "manager": clean(raw.get("project_manager")) or None,
            },
            "flags": flags,
        }


# ---------------------------------------------------------------------------
# Day-over-day differences
# ---------------------------------------------------------------------------

def diff(prev_rows, cur_rows, h):
    def by_id(rows):
        return {slug(clean(r.get("project_name"))): r for r in rows}

    a, b = by_id(prev_rows), by_id(cur_rows)
    added = [clean(b[k]["project_name"]) for k in b if k not in a]
    removed = [clean(a[k]["project_name"]) for k in a if k not in b]
    changed = []
    for k in b:
        if k not in a:
            continue
        fields = []
        for col in sorted(set(a[k]) | set(b[k])):
            if col in VOLATILE_COLUMNS:
                continue
            old, new = clean(a[k].get(col)), clean(b[k].get(col))
            if old != new:
                fields.append({"col": col, "from": old, "to": new})
        if fields:
            g_old, _ = h.lookup("stage", a[k].get("stage"), fallback="unmapped")
            g_new, _ = h.lookup("stage", b[k].get("stage"), fallback="unmapped")
            changed.append({
                "id": k, "name": clean(b[k]["project_name"]), "fields": fields,
                "stage_move": [g_old, g_new] if g_old != g_new else None,
            })
    return {"added": added, "removed": removed, "changed": changed}


def build_changes(index, h):
    snaps = index["snapshots"]
    out = []
    for prev, cur in zip(snaps, snaps[1:]):
        p = parse_csv((HISTORY / prev["file"]).read_bytes())
        c = parse_csv((HISTORY / cur["file"]).read_bytes())
        d = diff(p, c, h)
        out.append({"date": cur["date"], "prev_date": prev["date"], **d})
    out.reverse()  # newest first
    return {"snapshots": len(snaps), "first_snapshot": snaps[0]["date"] if snaps else None, "changes": out}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--file", help="read a local CSV instead of CSV_URL")
    ap.add_argument("--rebuild", action="store_true", help="do not fetch; rebuild JSON from the latest archived snapshot")
    ap.add_argument("--date", help="snapshot date override (YYYY-MM-DD), for back-filling")
    args = ap.parse_args()

    HISTORY.mkdir(parents=True, exist_ok=True)
    now = now_utc()
    today = args.date or now.date().isoformat()

    if args.rebuild:
        index = load_json(HISTORY / "index.json", {"snapshots": []})
        if not index["snapshots"]:
            raise SystemExit("No archived snapshot to rebuild from.")
        raw_bytes = (HISTORY / index["snapshots"][-1]["file"]).read_bytes()
        is_new = False
    else:
        if args.file:
            raw_bytes = Path(args.file).read_bytes()
        else:
            url = os.environ.get("CSV_URL")
            if not url:
                raise SystemExit("Set CSV_URL (GitHub secret) or pass --file.")
            try:
                raw_bytes = fetch(url)
            except Exception as exc:  # noqa: BLE001 — surface any network/auth failure clearly
                safe = re.sub(r"\?[^\s'\"\]]+", "?<token hidden>", str(exc))  # never print the SAS token
                raise SystemExit(f"Download failed: {safe}. HTTP 403 / curl exit 22 usually means the SAS token has expired.")
        rows = parse_csv(raw_bytes)
        index, is_new = archive(raw_bytes, rows, today)
        # Record the successful check so the site can warn when refreshes stop.
        index["last_checked"] = now.isoformat()
        write_json(HISTORY / "index.json", index)

    rows = parse_csv(raw_bytes)
    h = Harmoniser()
    seen = set()
    projects = [h.row(r, seen) for r in rows]

    known = [c[0] for c in COLUMNS]
    extra = [c for c in rows[0].keys() if c not in known]
    columns = [{"key": k, "label": l, "group": g} for k, l, g in COLUMNS if k in rows[0]]
    columns += [{"key": k, "label": k.replace("_", " ").capitalize(), "group": "Other"} for k in extra]

    latest_snap = index["snapshots"][-1]
    latest = {
        "generated_at": now.isoformat(),
        "last_checked": index.get("last_checked") or now.isoformat(),
        "snapshot_date": latest_snap["date"],
        "snapshot_file": "data/history/" + latest_snap["file"],
        "source_ingested_at": latest_snap.get("source_ingested_at"),
        "new_snapshot": is_new,
        "stage_groups": h.m.get("stage_groups", {}),
        "columns": columns,
        "projects": projects,
    }
    write_json(DATA / "latest.json", latest)
    write_json(DATA / "changes.json", build_changes(index, h))

    n_flags = sum(len(p["flags"]) for p in projects)
    print(f"{len(projects)} projects · snapshot {latest_snap['date']} ({'new' if is_new else 'unchanged'}) · {n_flags} data-quality notes")


if __name__ == "__main__":
    sys.exit(main())
