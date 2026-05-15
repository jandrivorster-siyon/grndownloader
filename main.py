import os
import time
from datetime import date, timedelta
from pathlib import Path

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeoutError

load_dotenv()

PORTAL_URL = os.environ["PORTAL_URL"]
USERNAME = os.environ["PORTAL_USERNAME"]
PASSWORD = os.environ["PORTAL_PASSWORD"]
SUPPLIER_NAME = os.environ["SUPPLIER_NAME"]
DAYS_BACK = int(os.environ.get("DAYS_BACK", "30"))
DOWNLOADS_DIR = Path(os.environ.get("DOWNLOADS_DIR", "downloads"))


def versioned_path(folder: Path, stem: str, suffix: str) -> Path:
    """Return a unique file path, appending _v1, _v2, ... if the file already exists."""
    candidate = folder / f"{stem}{suffix}"
    if not candidate.exists():
        return candidate
    version = 1
    while True:
        candidate = folder / f"{stem}_v{version}{suffix}"
        if not candidate.exists():
            return candidate
        version += 1


def login(page, url: str, username: str, password: str) -> None:
    page.goto(url)
    # TODO: update selectors to match your login form fields
    page.get_by_label("Username").fill(username)
    page.get_by_label("Password").fill(password)
    page.get_by_role("button", name="Login").click()
    page.wait_for_load_state("networkidle")
    print("  Logged in")


def select_supplier(page, supplier_name: str) -> None:
    # TODO: update to match how your portal presents the supplier selector
    # e.g. a dropdown, a search field, a list item — adjust accordingly
    page.get_by_role("combobox", name="Supplier").select_option(label=supplier_name)
    page.wait_for_load_state("networkidle")
    print(f"  Supplier selected: {supplier_name}")


def navigate_to_grn_report(page) -> None:
    # TODO: update link/menu text to match your portal navigation
    page.get_by_role("link", name="Reports").click()
    page.wait_for_load_state("networkidle")

    # TODO: update to match the "Download" sub-section label in your portal
    page.get_by_role("link", name="Download").click()
    page.wait_for_load_state("networkidle")

    # TODO: update to match the GRN report link/button label
    page.get_by_role("link", name="GRN Report").click()
    page.wait_for_load_state("networkidle")
    print("  Navigated to GRN Report")


def set_date_and_download(page, target_date: date, downloads_dir: Path) -> Path | None:
    date_str = target_date.strftime("%Y-%m-%d")
    display_date = target_date.strftime("%d/%m/%Y")  # TODO: adjust format if portal uses MM/DD/YYYY etc.

    # Step 4: set start and end date to the same day
    # TODO: update field labels/placeholders to match your portal's date inputs
    page.get_by_label("Start Date").fill(display_date)
    page.get_by_label("End Date").fill(display_date)

    # Step 5: click to list / search GRNs
    # TODO: update button label — e.g. "List", "Search", "Show GRN", etc.
    page.get_by_role("button", name="List").click()
    page.wait_for_load_state("networkidle")

    # Check if any results came back before proceeding
    # TODO: update selector to whatever indicates "no results" on your portal
    if page.locator("text=No records found").count() > 0:
        print(f"  No GRN records for {date_str} — skipping")
        return None

    # Step 6a: select all GRNs
    # TODO: update to match your "Select All" control — checkbox, button, etc.
    page.get_by_role("checkbox", name="Select All").check()

    # Step 6b: choose pipe-delimited format
    # TODO: update to match the format selector label in your portal
    page.get_by_role("combobox", name="Format").select_option(label="Pipe")

    # Step 6c: click Download GRN and capture the file
    dest_path = versioned_path(downloads_dir, f"GRN_{date_str}", ".txt")

    with page.expect_download() as download_info:
        # TODO: update button label — e.g. "Download GRN", "Export", "Download", etc.
        page.get_by_role("button", name="Download GRN").click()

    download = download_info.value
    download.save_as(dest_path)
    print(f"  Saved: {dest_path}")
    return dest_path


def run() -> None:
    DOWNLOADS_DIR.mkdir(parents=True, exist_ok=True)

    today = date.today()
    days = [today - timedelta(days=i) for i in range(DAYS_BACK)]

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(accept_downloads=True)
        page = context.new_page()

        try:
            login(page, PORTAL_URL, USERNAME, PASSWORD)
            select_supplier(page, SUPPLIER_NAME)
            navigate_to_grn_report(page)

            for target_date in days:
                print(f"Processing {target_date} ...")
                try:
                    set_date_and_download(page, target_date, DOWNLOADS_DIR)
                except PlaywrightTimeoutError:
                    print(f"  Timeout on {target_date} — skipping")
                except Exception as exc:
                    print(f"  Error on {target_date}: {exc} — skipping")

        finally:
            context.close()
            browser.close()

    print("Done.")


if __name__ == "__main__":
    run()
