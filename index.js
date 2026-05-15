require('dotenv').config();
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PORTAL_URL    = process.env.PORTAL_URL;
const USERNAME      = process.env.PORTAL_USERNAME;
const PASSWORD      = process.env.PORTAL_PASSWORD;
const SUPPLIER_CODE = process.env.SUPPLIER_CODE;
const DAYS_BACK     = parseInt(process.env.DAYS_BACK || '30', 10);
const DOWNLOADS_DIR = path.resolve(process.env.DOWNLOADS_DIR || 'downloads');
const TIMEOUT_MS    = parseInt(process.env.TIMEOUT_MS || '120000', 10); // default 2 minutes per action

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ASP.NET field names extracted from HAR
const FIELDS = {
  supplier:       'ctl00$loginView$cboSuppliers',
  filterOn:       'ctl00$cDC$grpFilterOn',
  startDateHidden:'ctl00$cDC$htxtStartDate',
  startDate:      'ctl00$cDC$txtStartDate',
  endDateHidden:  'ctl00$cDC$htxtEndDate',
  endDate:        'ctl00$cDC$txtEndDate',
  selectAll:      'ctl00$cDC$GRNRepeater$ctl00$chkSelectAll',
};

const GRN_PAGE = '/WebClients/SPort/GRNReportFilter.aspx';

// Returns YYYY/MM/DD format required by the portal
function formatDate(d) {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}/${mm}/${dd}`;
}

// Build array of dates: today, yesterday, ... going back DAYS_BACK days
function buildDateRange() {
  const dates = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = 0; i < DAYS_BACK; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    dates.push(d);
  }
  return dates;
}

// Return a unique file path — appends _v1, _v2, ... if file already exists
function versionedPath(dir, stem, ext) {
  let candidate = path.join(dir, `${stem}${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  let v = 1;
  while (true) {
    candidate = path.join(dir, `${stem}_v${v}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    v++;
  }
}

async function login(page) {
  await page.goto(PORTAL_URL, { timeout: TIMEOUT_MS });
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });

  const usernameField = page.locator('input[name*="txtUsername"], input[name*="UserName"], input[type="text"]').first();
  const passwordField = page.locator('input[name*="txtPassword"], input[name*="Password"], input[type="password"]').first();

  await usernameField.fill(USERNAME);
  await passwordField.fill(PASSWORD);

  // Press Enter to submit — more reliable than clicking a button that may be off-screen
  await passwordField.press('Enter');
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });

  console.log('  Logged in');
}

async function selectSupplier(page) {
  const dropdown = page.locator(`select[name="${FIELDS.supplier}"]`);
  if (await dropdown.count() > 0) {
    await dropdown.selectOption({ value: SUPPLIER_CODE });
    await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });
    await wait(2000);
    console.log(`  Supplier selected: ${SUPPLIER_CODE}`);
  }
}

async function navigateToGrnPage(page) {
  // Step 1 — click the top-level "Reports and Downloads" menu item
  await page.getByRole('link', { name: 'Reports and Downloads' }).click();
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });
  await wait(3000);
  console.log('  Clicked Reports and Downloads — current URL:', page.url());

  // Step 2 — if not yet on the GRN page, look for a GRN sub-link in the expanded menu
  if (!page.url().includes('GRNReportFilter')) {
    const grnLink = page.getByRole('link', { name: /grn/i }).first();
    if (await grnLink.count() > 0) {
      await grnLink.click();
      await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });
      await wait(3000);
      console.log('  Clicked GRN link — current URL:', page.url());
    }
  }

  console.log('  On GRN Report page');
}

async function downloadForDate(page, date, downloadsDir) {
  const dateStr     = formatDate(date);
  const fileStem    = `GRN_${dateStr.replace(/\//g, '-')}`;

  // Step 4 — select "Date Range" radio and fill start + end with the same day
  await page.locator(`input[name="${FIELDS.filterOn}"][value="radDateRange"]`).check();
  await wait(500);

  // The portal uses both a hidden input and a visible text input for dates
  await page.locator(`input[name="${FIELDS.startDateHidden}"]`).fill(dateStr);
  await page.locator(`input[name="${FIELDS.startDate}"]`).fill(dateStr);
  await page.locator(`input[name="${FIELDS.endDateHidden}"]`).fill(dateStr);
  await page.locator(`input[name="${FIELDS.endDate}"]`).fill(dateStr);
  await wait(500);

  // Step 5 — click the List/Search button to load GRN results
  // TODO: confirm button text; common labels are "List", "Search", "Filter", "Show"
  await page.locator('input[type="submit"][value*="List"], input[type="submit"][value*="Search"], input[type="submit"][value*="Filter"]').first().click();
  await page.waitForLoadState('networkidle', { timeout: TIMEOUT_MS });
  await wait(2000);

  // Check for no-results state before proceeding
  const noResults = await page.locator('text=/no records|no data|no grn/i').count();
  if (noResults > 0) {
    console.log(`  No GRN records for ${dateStr} — skipping`);
    return null;
  }

  // Step 6a — select all GRNs via the header checkbox
  await page.locator(`input[name="${FIELDS.selectAll}"]`).check();

  // Step 6b — select pipe-delimited format
  // The pipe radio sits in the repeater footer row; value is always "radSelectedPipe"
  await page.locator('input[value="radSelectedPipe"]').last().check();

  // Step 6c — click Download GRNs and capture the file
  const destPath = versionedPath(downloadsDir, fileStem, '.txt');

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: TIMEOUT_MS }),
    page.locator('input[value="Download GRNs"]').last().click(),
  ]);

  await download.saveAs(destPath);
  console.log(`  Saved: ${destPath}`);
  return destPath;
}

async function run() {
  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  const dates = buildDateRange();
  console.log(`Starting download for ${dates.length} day(s) into ${DOWNLOADS_DIR}\n`);

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page    = await context.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);

  try {
    await login(page);
    await navigateToGrnPage(page);
    await selectSupplier(page);

    for (const date of dates) {
      console.log(`Processing ${formatDate(date)} ...`);
      try {
        await downloadForDate(page, date, DOWNLOADS_DIR);
      } catch (err) {
        console.error(`  Error on ${formatDate(date)}: ${err.message} — skipping`);
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
