"""Make irreversible, flattened PDF screen examples. Originals stay outside the repo.

Usage: python build-beta-flex-examples.py DROPX_PDF AMAZON_PDF OUTPUT_DIR
Requires PyMuPDF. Coordinates refer to the embedded 720x1600 source screens.
Never publish the source PDFs or extracted original images.
"""
import json
import sys
from pathlib import Path
import pymupdf as pdf

dropx, amazon = pdf.open(sys.argv[1]), pdf.open(sys.argv[2])
output = Path(sys.argv[3])
output.mkdir(parents=True, exist_ok=True)
WHITE = (1, 1, 1)
GREY = (0.94, 0.96, 0.97)
INK = (0.22, 0.29, 0.34)
PINK = (0.77, 0.23, 0.40)
# x0, y0, x1, y1, replacement. Values and original document photos are removed.
screens = [
    dict(id="flex-signin", xref=20, page=8, crop=(0, 765, 720, 1510), masks=[
        (45, 925, 600, 985, "Your invited email"), (45, 1030, 675, 1104, "Your own Amazon password")], marks=[(645,952,1),(645,1065,2),(640,1340,3)]),
    dict(id="privacy", xref=25, page=10, crop=(0,70,720,1510), masks=[], marks=[(625,310,1),(620,1455,2)]),
    dict(id="about-name", xref=28, page=11, crop=(0,70,720,1510), masks=[
        (45,274,675,322,"Your legal first name"),(45,427,675,475,"Your legal middle name"),
        (45,580,675,628,"Your legal last name"),(45,840,675,892,"Your current address"),
        (45,1080,675,1130,"Address line 2"),(45,1320,675,1370,"Your city")],marks=[(645,296,1),(645,860,2)]),
    dict(id="about-contact", xref=29, page=11, crop=(0,70,720,1510), masks=[
        (45,233,630,283,"Your city"),(45,381,625,429,"Your state"),
        (45,536,675,581,"Your PIN code"),(45,687,675,734,"Your mobile number"),
        (45,971,625,1017,"Your selection"),(45,1125,625,1174,"Your selection")],marks=[(644,705,1),(620,1455,2)]),
    dict(id="licence-front", xref=33, page=13, crop=(0,70,720,1510), masks=[
        (34,322,687,660,"Your licence - FRONT"),(34,1048,489,1307,"Example document removed")],marks=[(645,350,1),(620,1355,2)]),
    dict(id="licence-back", xref=34, page=13, crop=(0,70,720,1510), masks=[
        (34,279,687,616,"Your licence - BACK"),(34,1006,490,1307,"Example document removed")],marks=[(645,310,1),(620,1355,2)]),
    dict(id="licence-review", xref=36, page=13, crop=(0,70,720,1510), masks=[
        (34,370,687,706,"Your licence - FRONT"),(34,786,687,1124,"Your licence - BACK"),
        (45,1280,675,1307,"Your date of birth")],marks=[(644,400,1),(620,1455,2)]),
    dict(id="profile-photo", xref=41, page=15, crop=(0,70,720,1510), masks=[
        (34,279,687,617,"Your own photo")],marks=[(645,310,1),(620,1355,2)]),
    dict(id="bgc-consent", xref=47, page=17, crop=(0,70,720,1510), masks=[],marks=[(643,290,1),(620,1455,2)]),
    dict(id="bgc-details", xref=44, page=16, crop=(0,70,720,1510), masks=[
        (45,299,675,348,"Your name as on PAN"),(45,455,675,498,"Your PAN number"),
        (45,606,675,653,"Father's first name as on PAN"),(45,758,675,805,"Father's last name as on PAN"),
        (35,1140,90,1280,"")],marks=[(645,320,1),(645,472,2)]),
    dict(id="bgc-address", xref=45, page=16, crop=(0,70,720,1510), masks=[
        (45,342,675,390,"Your permanent address"),(45,583,675,631,"Your city"),
        (45,733,625,781,"Your state"),(45,883,675,931,"Your PIN code")],marks=[(645,365,1),(620,1455,2)]),
    dict(id="eshram-uan", xref=43, page=16, crop=(0,70,720,1510), masks=[
        (45,414,675,462,"Your name as on UAN ID"),(45,925,675,977,"Your own e-Shram UAN")],marks=[(642,438,1),(642,950,2),(620,1320,3)]),
    dict(id="account-review", source="amazon", xref=150, page=34, crop=(4,4,308,492), masks=[],marks=[]),
    dict(id="account-resolve", source="amazon", xref=150, page=34, crop=(336,4,607,492), masks=[],marks=[]),
    dict(id="training-task", xref=38, page=14, crop=(0,70,720,370), masks=[],marks=[(540,324,1)]),
]

safe = pdf.open()
manifest = []
for item in screens:
    doc = amazon if item.get("source") == "amazon" else dropx
    original = doc.extract_image(item["xref"])
    # A fresh PDF page carries the screen. Native PDF redaction removes pixels,
    # then only a flattened raster is exported; no hidden source is shipped.
    working = pdf.open()
    page = working.new_page(width=original["width"], height=original["height"])
    page.insert_image(page.rect, stream=original["image"])
    masks = item["masks"]
    for x0,y0,x1,y1,text in masks:
        page.add_redact_annot(pdf.Rect(x0,y0,x1,y1), fill=GREY if y1-y0>100 else WHITE)
    # Remove the old PDF's numbered header bubble; these examples have their own callouts.
    if item.get("source") != "amazon" and item["id"] != "flex-signin":
        page.add_redact_annot(pdf.Rect(27,77,86,179),fill=(0.72,0.89,0.98))
    page.apply_redactions(images=2)
    for x0,y0,x1,y1,text in masks:
        if text:
            font=26 if y1-y0>100 else 24
            if y1-y0 <= 100:
                page.insert_text((x0+10, y0+(y1-y0+font*.7)/2),text,fontname="helv",fontsize=font,color=INK)
            else:
                rect=pdf.Rect(x0+10, y0+(y1-y0-font*1.4)/2, x1-12,y1)
                page.insert_textbox(rect,text,fontname="helv",fontsize=font,color=INK,align=1)
    if item["id"] == "bgc-details":
        for y in (1171,1250): page.draw_circle((54,y),18,color=(0.45,0.5,0.5),width=2)
    for x,y,label in item["marks"]:
        page.draw_circle((x,y),21,color=WHITE,fill=PINK,width=3)
        page.insert_text((x-6.5,y+8),str(label),fontname="hebo",fontsize=23,color=WHITE)
    clip=pdf.Rect(item["crop"])
    raster=page.get_pixmap(clip=clip,alpha=False)
    raster.save(str(output/f'{item["id"]}.png'))
    clean = safe.new_page(width=raster.width,height=raster.height)
    clean.insert_image(clean.rect,stream=raster.tobytes("png"))
    manifest.append({"id":item["id"],"source":item.get("source","dropx"),"page":item["page"],"width":raster.width,"height":raster.height,"redactedRegions":len(masks),"flattened":True})
    working.close()
safe.save('/tmp/dropx-guides/sanitized-screen-examples.pdf',garbage=4,deflate=True)
(output/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(f'Wrote {len(manifest)} flattened examples; original images are not in output.')
