#!/usr/bin/env python3
"""Hero Board weekly Span of Control sync: turn the Microsoft 365 connector's text
read of the two SharePoint workbooks into one SQL call to public.hb_sync_span().

  python3 -I scripts/span_sync.py SPAN.txt MASTER.txt OUT.sql [--apply]

SPAN.txt   = full read_resource text of "UPDATED Span of control (Store Level).xlsx" (sheet "New")
MASTER.txt = full read_resource text of "Master_Location_Mapping.xlsx" (sheet "Location_Mapping"), or "-" to skip
Without --apply the SQL is a dry run (reports changes, writes nothing but the run log).
Prints REFUSED and exits 2 if the input does not look right.
"""
import json, re, sys

def refuse(msg):
    print("REFUSED: " + msg); sys.exit(2)

def sheet_rows(text, sheet):
    """Rows (list of cells) of one '## Sheet: <name>' section, header first."""
    m = re.search(r"^## Sheet: " + re.escape(sheet) + r"\b.*$", text, re.M)
    if not m:
        return None
    rows = []
    for line in text[m.end():].splitlines()[1:]:
        if line.startswith("## Sheet:") or line.startswith("Formulas:") or line.startswith("[Sheets "):
            break
        if line.strip():
            rows.append([c.strip() for c in line.split("\t")])
    return rows

def col(header, *names):
    h = [x.upper().strip() for x in header]
    for n in names:
        if n in h:
            return h.index(n)
    return None

def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--apply" in sys.argv
    if len(args) != 3:
        refuse("usage: span_sync.py SPAN.txt MASTER.txt|- OUT.sql [--apply]")
    span_txt = open(args[0], encoding="utf-8").read()
    rows = sheet_rows(span_txt, "New")
    if not rows:
        refuse('sheet "New" not found in the span file text')
    hdr, data = rows[0], rows[1:]
    ib, ia, ir = col(hdr, "BRANCH NAME", "BRANCH"), col(hdr, "AREA MANAGER", "AREA MANAGER/ROM"), col(hdr, "REGIONAL MANAGER", "ROM", "REGIONAL OPERATIONS MANAGER")
    if None in (ib, ia, ir):
        refuse("span sheet headers changed: " + " | ".join(hdr))
    span = []
    for r in data:
        r = r + [""] * (len(hdr) - len(r))
        if r[ib] and (r[ia] or r[ir]):
            span.append({"branch": r[ib], "area_manager": r[ia], "rom": r[ir]})
    if len(span) < 50:
        refuse(f"only {len(span)} branch rows found in the span file (expected about 100); the read may be incomplete")

    locs = []
    if args[1] != "-":
        mrows = sheet_rows(open(args[1], encoding="utf-8").read(), "Location_Mapping")
        if not mrows:
            refuse('sheet "Location_Mapping" not found in the master mapping text')
        mh = mrows[0]
        ic, icity, ireg = col(mh, "SYRVE_CODE"), col(mh, "CITY"), col(mh, "REGION")
        if None in (ic, icity, ireg):
            refuse("master mapping headers changed")
        for r in mrows[1:]:
            r = r + [""] * (len(mh) - len(r))
            if re.match(r"^B\d{1,3}$", r[ic].strip(), re.I) and (r[icity] or r[ireg]):
                locs.append({"code": r[ic].strip(), "city": r[icity], "region": r[ireg]})
        if len(locs) < 50:
            refuse(f"only {len(locs)} branches found in the master mapping (expected about 100)")

    j = lambda v: json.dumps(v, ensure_ascii=False)
    sql = f"select public.hb_sync_span($span${j(span)}$span$::jsonb, $loc${j(locs)}$loc$::jsonb, {'true' if apply else 'false'}) as result;\n"
    open(args[2], "w", encoding="utf-8").write(sql)
    print(f"OK: {len(span)} span rows, {len(locs)} location rows, {'APPLY' if apply else 'DRY RUN'} -> {args[2]} ({len(sql)} bytes)")

if __name__ == "__main__":
    main()
