# Physical station audit: inspection and scoring

This operational checklist adapts public safety guidance and DropX station controls. It is not a claim of certification against an Amazon DSP audit standard.

## Walkthrough

1. **Shipments (30%)**: paste unique ERP ageing TIDs, scan physical parcels and review automatic missing / excess findings. Confirm observations. Inventory accuracy has four times the weight of the findings-completeness check within this area.
2. **COD (30%)**: record system cash with ERP proof, enter denomination counts, review automatic available cash / difference, and verify remittance. Cash accuracy has four times the weight of the remittance check.
3. **Hygiene and welfare (15%)**: floors / wet mopping, dust on surfaces and racks, waste and pests, toilet cleanliness, washroom water / soap / drainage, dated twice-weekly cleaning records, drinking water, ventilation and rest facilities. Photos are required for every hygiene outcome, including N/A.
4. **Security (10%)**: visitor access, office key holders, keys carried away rather than hidden at the station, cash key custodians, locked cash counter / locker, and 60-day CCTV retention.
5. **Handling and returns (5%)**: inbound/outbound process, RTS/RTSW, ageing clearance, morning unloading CCTV, labelled bins and shipment placement, damage handling, orphan connection, delivered parcels remaining at station, stable stacking and safe manual handling.
6. **Safety and layout (5%)**: 5S, marked walkways / loading / storage areas, unobstructed emergency exits and contact information, fire safety, first aid and electrical safety. Photos support every safety outcome. Do not invent mandatory Amazon colour codes or dimensions.
7. **Equipment (5%)**: IT systems / laptops / printers, fans / ventilation cleanliness and equipment condition; photographs support the inspection.

All areas, weights, check guidance, outcomes, evidence requirements and rating bands are editable in Audit Master. These are seed defaults, not UI-coded checklist questions. Binary controls remain compliant / non-compliant; cleanliness uses Fantastic (100), Great (80), Fair (50), Poor (0), or N/A with a reason.

## Why these weights

COD and inventory account for 60% because they are the primary loss controls. Hygiene is the next largest area because a safe, usable station must be consistently maintained. Access/security is preventive. Handling, layout and equipment round out the operating controls without making a minor housekeeping detail equivalent to a cash or inventory failure.

Cash accuracy = 100 × (1 − absolute cash difference / the larger of expected and counted cash). Zero expected and counted is 100%. Shipment accuracy = 100 × (1 − chargeable missing and excess / eligible TIDs). Duplicates count once. Large financial or inventory differences affect accuracy proportionally; they remain separately visible as findings even when an overall rating is high.

A section averages applicable checks using their check weights. Overall percentage averages section scores using area weights. Master weights are normalized to 100%; sections/checks genuinely not applicable are excluded and the remaining weights are normalized. Default overall rating bands: Fantastic ≥90, Great ≥75, Fair ≥50, Poor <50.

## Fair responsibility assessment

For cash, each TID difference, and non-compliant checklist findings:

- **Within station control**: explain the cause; include in scoring.
- **Already reported missing by DA before audit**: verify dated missing-scan proof; exclude from the station score.
- **Outside station control**: verify the reason against supporting evidence; exclude.
- **Pending investigation**: do not deduct points pending attribution, but keep the report provisional and block closure until review.

Exclusion does not erase a discrepancy, close a corrective action or initiate a payroll recovery. The station responds in OpsPulse. An authorized audit manager reviews responsibility using the original score rules. Score changes retain before/after history and update the report email. A provisional result must not be used as a final R&R/appraisal score. Final decisions remain human decisions.

## Reports

A saved report includes percentage, rating, area weights/contributions, check outcomes, observations, named custodians, linked photos, responsibility decisions, COD totals, shipment findings, station response and corrective actions. Download the illustrated PDF from the audit detail. The station/cluster-manager email includes a score table, selected actual evidence thumbnails, the PDF and an OpsPulse response link. Private manager notes are not included in the station-facing PDF.

## Public reference material

- [Amazon Supply Chain Standards](https://sustainability.aboutamazon.com/amazon-supply-chain-standards-english.pdf): emergency preparation and exits, safe handling, sanitation, drinking water, heat and ventilation.
- [Amazon India summer safety measures](https://www.aboutamazon.in/news/operations/how-amazon-keeps-employees-and-drivers-safe-this-summer): accessible hydration, rest and cooling/ventilation.
- [Amazon workplace safety update](https://www.aboutamazon.com/news/workplace/amazon-safety): material handling and slip/trip prevention.

DropX-specific requirements such as twice-weekly washroom cleaning, 60-day CCTV retention, COD counting and key custody come from the requested operating policy, not a claim that these thresholds are public Amazon mandates.
