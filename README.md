# PC Part Dataset

A dataset of PC parts scraped from [PCPartPicker](https://pcpartpicker.com),
plus the scraper that produces it.

Part count: **66,778**

Data last updated: **July 23, 2025**

## Download

The parts are available in JSON, JSON Lines, and CSV format. You can find them
in the [`./data`](./data) directory.

## JSON Property Descriptions

Check out [API.md](./API.md) for JSON property descriptions of each product
category.

## Contents

- General

  - CPUs
  - CPU Coolers
  - Motherboards
  - Memory
  - Storage
  - Video Cards
  - Cases
  - Power Supplies
  - Optical Drives
  - Operating Systems
  - Monitors
  - External Storage

- Accessories / Other

  - Case Accessories
  - Case Fans
  - Fan Controllers
  - Thermal Compound
  - UPS Systems

- Expansion Cards / Networking

  - Sound Cards
  - Wired Network Adapters
  - Wireless Network Adapters

- Peripherals
  - Headphones
  - Keyboards
  - Mice
  - Speakers
  - Webcams

## Running the Scraper

> **PCPartPicker is behind Cloudflare and refuses datacenter IPs.**
> From a VPS, a container, or a GitHub-hosted runner you will be challenged
> before any markup is served. Run from a residential connection, or pass
> `--proxy` with a residential endpoint.

```sh
npm install

# Check reachability and whether the markup still matches, before scraping.
npm run probe -- memory

# Scrape everything
npm run scrape

# Or just the categories you want
npm run scrape -- cpu memory motherboard
```

Output lands in `data-staging/runs/<runId>/`, with `data-staging/latest`
symlinked to the most recent run:

```
data-staging/
  runs/2026-08-19T22-01-30-092Z/
    memory.json         finalized array
    memory.jsonl        append-only, written page by page
    checkpoint.json     which pages are durably on disk
    report.json         per-endpoint status, drift, errors
  latest -> runs/2026-08-19T22-01-30-092Z
```

### Check it still works first

`npm run probe -- <endpoint>` loads one page and reports whether the site
served you at all, whether every selector the scraper depends on still
matches, which spec labels the category renders today versus what
`src/serialization-map.json` expects, and every XHR the page issues while
paginating. It writes a Markdown report and the raw HTML to
`data-staging/probe/`.

Run this after any long gap. PCPartPicker changes its markup, and the probe
tells you what changed in about ten seconds rather than after a four-hour
scrape.

### Schema drift

PCPartPicker adds and removes spec columns without warning. When it adds one,
the scraper keeps the value under a derived key (`Heat Spreader` becomes
`heat_spreader`) and lists it at the end of the run:

```
UNMAPPED SPEC LABELS (1) — add these to src/serialization-map.json:
  memory                 "Heat Spreader"              x1  e.g. "Yes"
```

Add an entry to [`src/serialization-map.json`](./src/serialization-map.json)
to give it a stable name and serialization. When PCPartPicker *removes* a
column, the run reports that too, under `MAPPED LABELS THAT NEVER APPEARED`.

Pass `--fail-on-drift` to exit non-zero when anything is unmapped — useful as
a scheduled canary.

### Resuming

Every page is checkpointed as it is written, so an interrupted run picks up
where it stopped:

```sh
npm run scrape -- memory --resume=2026-08-19T22-01-30-092Z
```

### Flags

```
--out=DIR            Output directory              (default: data-staging)
--concurrency=N      Parallel tabs                 (default: 3)
--delay=MS           Base delay between navigations(default: 1200)
--jitter=MS          Random extra delay 0..MS      (default: 800)
--retries=N          Attempts per page             (default: 3)
--timeout=MS         Navigation timeout            (default: 45000)
--headless=false     Show the browser
--proxy=URL          http://user:pass@host:port
--resume=RUN_ID      Continue a previous run
--max-pages=N        Stop after N pages per endpoint (smoke test)
--fail-on-drift      Exit non-zero if an unmapped spec label appears
--sandbox=false      Pass --no-sandbox (needed as root / in containers)
```

Each has an environment equivalent (`SCRAPER_PROXY`, `SCRAPER_CONCURRENCY`,
`SCRAPER_DELAY_MS`, ...); see `npm run scrape -- --help`.

`SCRAPER_BASE_URL` points the scraper somewhere other than PCPartPicker,
which is how the end-to-end tests run offline.

## `package.json` Scripts

- `scrape` — runs the scraper.
- `scrape:dev` — same, without typechecking.
- `probe` — diagnoses the current state of PCPartPicker's markup.
- `count` — counts parts in a run directory (default `data-staging/latest`).
- `output` — writes JSONL and CSV alongside the JSON in a run directory.
- `typecheck` — `tsc --noEmit`.
- `test` — unit tests plus extraction tests that drive a real Chromium
  against an offline fixture.
- `zip` — zips the JSON, JSONL, and CSV folders in `./data`.

## Legal

PCPartPicker's terms prohibit automated collection, and the site is actively
bot-protected. This repository is published for research and personal use;
scraping it into a commercial product is your risk to assess, not a settled
question. For motherboard/CPU memory compatibility specifically, vendor QVLs
and Intel ARK are both authoritative and unambiguously usable.

## License

[MIT](./LICENSE)
