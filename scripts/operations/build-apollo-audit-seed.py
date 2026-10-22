"""Build supabase/seeds/amazon-now-apollo-audit.json from tmp-apollo-questions.json."""
from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "tmp-apollo-questions.json"
OUT = ROOT / "supabase" / "seeds" / "amazon-now-apollo-audit.json"

SECTION_META = OrderedDict(
    [
        (
            "Hygiene & Upkeep",
            ("hygiene", "Washrooms, dust, cleaning records and site upkeep."),
        ),
        (
            "Food Safety",
            (
                "food",
                "Temperature, pest control, segregation and chilled packing. Record readings where asked.",
            ),
        ),
        (
            "Quality",
            (
                "quality",
                "Stowage quality, counts, produce condition and quality OPLs. Sample as noted on each check.",
            ),
        ),
        (
            "Picker Knowledge",
            (
                "picker",
                "Shadow pickers on the floor. Record who was checked and any coaching needed.",
            ),
        ),
        (
            "People Presence & Knowledge",
            ("people", "Staffing plan and role awareness for key store roles."),
        ),
        (
            "Compliance & Documents",
            (
                "compliance",
                "Licences, contracts and displayed compliance documents. Capture validity where asked.",
            ),
        ),
        (
            "Integrity Checks",
            ("integrity", "Physical vs system integrity and CCTV checks."),
        ),
        (
            "LM Controllable",
            ("lm", "Last-mile controllable process checks on the floor."),
        ),
        ("LM - UTR Controllable", ("lm_utr", "UTR controllable checks.")),
        (
            "Counts",
            ("counts", "Headcount and volume snapshot for the visit. Not scored."),
        ),
    ]
)


def hours(fix_within: str | None) -> int:
    s = (fix_within or "").strip().lower()
    if s.startswith("24"):
        return 24
    if s.startswith("48"):
        return 48
    if "30 day" in s:
        return 720
    if s.startswith("7"):
        return 168
    return 24


def severity(failed_in, is_count: bool) -> str:
    if is_count:
        return "normal"
    try:
        n = int(failed_in or 0)
    except Exception:
        n = 0
    if n >= 5:
        return "critical"
    if n >= 3:
        return "high"
    return "normal"


def evidence_for(photo: str, is_count: bool) -> dict:
    p = (photo or "").strip().lower()
    if is_count or p in ("none", "-", ""):
        return {"when": "optional", "min": 0, "max": 5}
    if "always" in p:
        return {"when": "always", "min": 1, "max": 5}
    if "cctv" in p:
        return {"when": "optional", "min": 0, "max": 5}
    return {"when": "gap", "min": 1, "max": 5}


def response_evidence(is_count: bool) -> dict:
    if is_count:
        return {"when": "optional", "min": 0, "max": 5}
    return {"when": "always", "min": 1, "max": 5}


def extra_fields(extra: str) -> list[dict]:
    e = (extra or "").strip()
    if not e or e == "-":
        return []
    fields: list[dict] = []
    low = e.lower()
    if "no. of instances" in low or "number of instances" in low:
        fields.append(
            {
                "id": "instances",
                "label": "No. of instances",
                "type": "number",
                "when": "gap",
            }
        )
    if low == "number":
        fields.append(
            {"id": "count", "label": "Count", "type": "number", "when": "always"}
        )
    if "reading (c)" in low:
        fields.append(
            {
                "id": "reading_c",
                "label": "Reading (°C)",
                "type": "number",
                "when": "always",
            }
        )
    if "bin id" in low:
        fields.append(
            {"id": "bin_ids", "label": "Bin IDs", "type": "text", "when": "gap"}
        )
    if "licence no" in low:
        fields.append(
            {
                "id": "licence_no",
                "label": "Licence number",
                "type": "text",
                "when": "always",
            }
        )
    if "expiry date" in low:
        fields.append(
            {
                "id": "expiry_date",
                "label": "Expiry date",
                "type": "text",
                "when": "always",
            }
        )
    return fields


def default_action(label: str, owner: str | None) -> str:
    who = owner if owner not in (None, "-", "") else "Store Manager or Store In-charge"
    return f"Correct the finding for: {label}. Owner default: {who}."


def main() -> None:
    qs = json.loads(SRC.read_text(encoding="utf-8"))
    sections = OrderedDict()
    for name, (sid, guidance) in SECTION_META.items():
        sections[name] = {
            "id": sid,
            "name": name,
            "guidance": guidance,
            "questions": [],
        }

    for q in qs:
        is_count = q["id"].startswith("N") or q["section"] == "Counts"
        options = q["options"]
        allow_na = "NA" in options
        compliant = (q["compliant"] or "").strip()
        if is_count:
            kind = "count"
            compliant_answer = None
            scored = False
            allow_na = False
        else:
            kind = "yes_no_na" if allow_na else "yes_no"
            compliant_answer = (
                compliant.lower() if compliant.lower() in ("yes", "no") else "yes"
            )
            scored = True

        fields = extra_fields(q["extra"])
        if scored and not any(f["id"] == "instances" for f in fields):
            fields.append(
                {
                    "id": "instances",
                    "label": "No. of instances",
                    "type": "number",
                    "when": "gap",
                }
            )

        photo = q["photo"] or ""
        guidance_bits = []
        if photo and photo not in ("None", "-"):
            guidance_bits.append(f"Proof: {photo}.")
        if q["extra"] and q["extra"] not in (
            "-",
            "No. of instances (if non-compliant)",
        ):
            guidance_bits.append(f"Also record: {q['extra']}.")
        failed = q.get("failedIn")
        if failed not in (None, "", "-") and str(failed).isdigit():
            guidance_bits.append(
                f"Failed in {failed} of 8 Amazon audits (source history)."
            )

        question = {
            "id": q["id"],
            "label": q["label"],
            "guidance": " ".join(guidance_bits),
            "required": True,
            "allowNA": allow_na,
            "kind": kind,
            "scored": scored,
            "compliantAnswer": compliant_answer,
            "extraFields": fields,
            "defaultOwner": q["owner"]
            if q["owner"] not in (None, "-", "")
            else "Store Manager or Store In-charge",
            "evidence": evidence_for(photo, is_count),
            "responseEvidence": response_evidence(is_count),
            "action": default_action(q["label"], q["owner"]),
            "hours": hours(q["fixWithin"]),
            "severity": severity(q.get("failedIn"), is_count),
        }
        sections[q["section"]]["questions"].append(question)

    template = {
        "name": "Amazon Now · Apollo store audit",
        "description": (
            "Mirrors Amazon CM_DS_Visit_Audit (received 22 Oct 2026): 79 scored "
            "questions in 9 sections + 4 counts. Compliant answer = the answer that "
            "passes (some questions are worded negatively). Self, mock and Amazon-log "
            "audits share this bank. Surprise mock: stores see results only after completion."
        ),
        "sections": list(sections.values()),
    }
    OUT.write_text(json.dumps(template, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    allq = [qq for s in template["sections"] for qq in s["questions"]]
    print("wrote", OUT)
    print("sections", len(template["sections"]))
    print(
        "questions",
        len(allq),
        "scored",
        sum(1 for x in allq if x["scored"]),
        "counts",
        sum(1 for x in allq if not x["scored"]),
    )
    print([(s["id"], len(s["questions"])) for s in template["sections"]])


if __name__ == "__main__":
    main()
