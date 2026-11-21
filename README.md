# VTech Auction Tracker — auction.vtech.services

Daily watch of GeM (gem.gov.in) bids and reverse auctions for VTech Technologies.

- **Runs** every day at 07:30 IST (Cloudflare cron). Pulls open GeM bids published in the last 3 days that match the admin's keywords (max 10) through the Apify GeM scraper (`automatic/gem-tenders-scraper`), stores them in D1, and emails the new ones to the recipient list.
- **UI**: search and filter bids, mark each one new / interested / submitted / ignored, manage keywords and recipients, manage users.
- **Stack**: one Cloudflare Worker (`src/index.ts`) + D1 + static `public/index.html`. Push to `main` deploys via Workers Builds.

## Setup (once)
1. Cloudflare dashboard → Worker `vtech-auction-tracker` → Settings → Variables → add **secret** `APIFY_TOKEN` (Apify account → Settings → API & Integrations).
2. Open https://auction.vtech.services and create the admin account with `ADMIN_EMAIL` (set in `wrangler.jsonc`).
3. Each email recipient must be verified once: Cloudflare → Email Routing → Destination addresses → Add (they click the link Cloudflare sends).

## Local dev
`npm i && npx wrangler dev` — uses a local D1; tables are created on first request.
