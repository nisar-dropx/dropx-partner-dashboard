const FEDNET = "fednet.federal.bank.in";
export const FEDNET_LOGIN = "https://fednet.federal.bank.in/";
const HEADERS = [
  "Sl No.",
  "Date",
  "Transaction ID",
  "Particulars",
  "Cheque Number",
  "Amount Type",
  "Amount",
  "Balance Amount",
];

export function isStatementUrl(value) {
  const u = new URL(value);
  return (
    u.protocol === "https:" &&
    u.hostname === FEDNET &&
    u.pathname === "/prod/statementnew/"
  );
}
export async function collectFednet(page) {
  if (!isStatementUrl(page.url()))
    throw Error(
      "Open Statements of Accounts in the FedNet session, then collect again.",
    );
  const read = () =>
    page.evaluate(() => ({
      headers: [
        ...document.querySelectorAll("#DataTables_Table_0 thead th"),
      ].map((e) => e.innerText.trim()),
      rows: [...document.querySelectorAll("#DataTables_Table_0 tbody tr")].map(
        (tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()),
      ),
      account: document
        .querySelector(".header-navbar")
        ?.innerText.match(/Acc No:\s*(\d+)/i)?.[1],
      start: document.querySelector("#transaction_date_from")?.value,
      end: document.querySelector("#transaction_date_to")?.value,
      type: document.querySelector("#transaction_type")?.value,
      amountFrom: document.querySelector("#amount_from")?.value,
      amountTo: document.querySelector("#amount_to")?.value,
      cheque: document.querySelector("#instrument_cheque_no")?.value,
      info: document.querySelector("#DataTables_Table_0_info")?.innerText,
      previousDisabled: document
        .querySelector("#DataTables_Table_0_previous")
        ?.classList.contains("disabled"),
      nextDisabled: document
        .querySelector("#DataTables_Table_0_next")
        ?.classList.contains("disabled"),
    }));
  let first = await read();
  // Always start at page one, using only the table's ordinary pagination controls.
  for (let count = 0; !first.previousDisabled && count < 500; count++) {
    const before = first.info;
    await page.click("#DataTables_Table_0_previous");
    await page.waitForFunction(
      (old) =>
        document.querySelector("#DataTables_Table_0_info")?.innerText !== old,
      { timeout: 15000 },
      before,
    );
    first = await read();
  }
  if (!first.previousDisabled)
    throw Error("Unable to reach the first statement page.");
  if (JSON.stringify(first.headers) !== JSON.stringify(HEADERS))
    throw Error("FedNet statement layout changed; collection stopped.");
  if (
    first.amountFrom ||
    first.amountTo ||
    first.cheque ||
    !["", "all", "a"].includes(String(first.type).toLowerCase())
  )
    throw Error("Clear statement filters and select All transaction types.");
  const totalMatch = /of\s+([\d,]+)\s+entries/i.exec(first.info ?? "");
  const total = Number(totalMatch?.[1].replace(/,/g, ""));
  if (!total || total > 5000)
    throw Error("Choose a statement period with 1–5,000 transactions.");
  const rows = [];
  let current = first;
  const context = (p) =>
    JSON.stringify([
      p.account,
      p.start,
      p.end,
      p.type,
      p.amountFrom,
      p.amountTo,
      p.cheque,
    ]);
  for (let count = 0; count < 500; count++) {
    if (
      !isStatementUrl(page.url()) ||
      context(current) !== context(first) ||
      (!current.info?.endsWith(`${total.toLocaleString("en-US")} entries`) &&
        !current.info?.endsWith(`${total} entries`))
    )
      throw Error("Statement changed during collection.");
    if (JSON.stringify(current.headers) !== JSON.stringify(HEADERS))
      throw Error("Statement layout changed.");
    rows.push(...current.rows);
    if (rows.length > total) throw Error("Statement pagination repeated rows.");
    if (current.nextDisabled) break;
    const before = current.info;
    await page.click("#DataTables_Table_0_next");
    await page.waitForFunction(
      (old) =>
        document.querySelector("#DataTables_Table_0_info")?.innerText !== old,
      { timeout: 15000 },
      before,
    );
    current = await read();
  }
  // Re-read page one: same-day postings can shift pagination during collection.
  const lastInfo = current.info;
  if (!first.nextDisabled) {
    await page.click('#DataTables_Table_0_paginate a[data-dt-idx="1"]');
    await page.waitForFunction(
      (old) =>
        document.querySelector("#DataTables_Table_0_info")?.innerText !== old,
      { timeout: 15000 },
      lastInfo,
    );
    const after = await read();
    if (
      JSON.stringify(after.rows) !== JSON.stringify(first.rows) ||
      after.info !== first.info ||
      context(after) !== context(first)
    )
      throw Error(
        "New bank activity arrived during collection. Please collect again.",
      );
  }
  return {
    ...first,
    rows,
    total,
    complete: current.nextDisabled === true && rows.length === total,
  };
}

export async function cocloudInventory(page) {
  const u = new URL(page.url());
  if (u.origin !== "https://app.cocloud.in" || u.pathname !== "/file-manager")
    throw Error(
      "Open the CoCloud File Manager and select Export in the live session.",
    );
  const result = await page.evaluate(() => ({
    path: [
      ...document.querySelectorAll(
        ".breadcrumb-modern .breadcrumb-item-modern",
      ),
    ].map((e) => e.innerText.trim()),
    rows: [...document.querySelectorAll("table tbody tr")].map((tr) =>
      [...tr.querySelectorAll("td")].map((td) => td.innerText.trim()),
    ),
  }));
  if (JSON.stringify(result.path) !== JSON.stringify(["Home", "Export"]))
    throw Error("Open CoCloud File Manager > Export before collecting files.");
  return {
    capturedAt: new Date().toISOString(),
    files: result.rows
      .filter((r) => r.length >= 5)
      .map((r) => ({
        name: r[1].replace(/[\uE000-\uF8FF]/g, "").trim(),
        size: r[2],
        modified: r[4],
      })),
    scope: "visible page only",
    message:
      "Export inventory only. Tally vouchers have not been imported or posted.",
  };
}

export async function stageCoCloudXml(page, filename, xml) {
  if (!/^fin-tally-[a-f0-9-]{36}\.xml$/.test(filename))
    throw Error("Invalid posting filename.");
  const inventory = await cocloudInventory(page);
  if (inventory.files.some((f) => f.name === filename))
    throw Error(
      "CoCloud already contains this package. Inspect it before proceeding.",
    );
  const clickText = async (selector, label) => {
    const candidates = await page.$$(selector),
      matches = [];
    for (const el of candidates) {
      if (
        await el.evaluate(
          (node, t) =>
            node.textContent.replace(/[\uE000-\uF8FF]/g, "").trim() === t,
          label,
        )
      )
        matches.push(el);
    }
    if (matches.length !== 1)
      throw Error(`CoCloud ${label} control is missing or ambiguous.`);
    await matches[0].click();
  };
  await clickText("button", "File Operations");
  await clickText("a", "Upload");
  const selector = 'input[type="file"][multiple]:not([webkitdirectory])';
  await page.waitForSelector(selector, { timeout: 10000 });
  const count = await page.$$eval(selector, (els) => els.length);
  if (count !== 1) throw Error("CoCloud file picker is ambiguous.");
  // DOM file input transfer avoids relying on paths in the remote browser's OS.
  await page.$eval(
    selector,
    (input, data) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File([data.xml], data.filename, { type: "application/xml" }),
      );
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    { filename, xml },
  );
  await page.waitForFunction(
    () =>
      [...document.querySelectorAll("button")].some(
        (b) => b.textContent.trim() === "Confirm Upload" && !b.disabled,
      ),
    { timeout: 10000 },
  );
  await clickText("button", "Confirm Upload");
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("table tbody tr")].some(
        (tr) =>
          tr
            .querySelectorAll("td")[1]
            ?.innerText.replace(/[\uE000-\uF8FF]/g, "")
            .trim() === name,
      ),
    { timeout: 45000 },
    filename,
  );
  const after = await cocloudInventory(page);
  if (!after.files.some((f) => f.name === filename))
    throw Error(
      "CoCloud upload result is uncertain. Inspect File Manager before retrying.",
    );
  return {
    filename,
    folder: "Export",
    message:
      "XML package is visible in CoCloud Export. Complete the Tally import once, then verify with a fresh Day Book export.",
  };
}
