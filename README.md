# Shopbooks

Free, offline-first bookkeeping and sales-tax helper for small businesses. It runs on your phone, desktop or browser from a single build, keeps a full copy of your books on every device, and syncs through your own free Cloudflare account. Nothing is hosted by anyone else, and the code here never contains anyone's financial data.

**Status:** early. Phase 0 is the event sales log, used for markets, fairs and pop-ups.

## What works today

- **Event sales log:** opening cash float, a bill-and-coin counter, daily cash and card sales, cash paid out of the box, deposits, and a cash-box reconciliation that keeps your float separate from income.
- **Tax-included pricing:** each day's total is split into sales before tax and the sales tax inside it, at your state and local rates.
- **Offline first:** the app installs to your phone's home screen (Android or iPhone) and works with no signal. Sync catches up when you're back online.
- **Your data, your account:** a passcode-protected sync API and a D1 database in your own Cloudflare account. You can download a CSV per event and a full JSON backup.

## Roadmap

1. Ledger, statement imports (CSV first), and matching bank lines to orders and payouts
2. Xero-style review screen with splits and rules
3. Florida DR-15 walkthrough and printable worksheet (other states can be added as plug-ins)
4. Reports, 1099-K reconciliation, and Form 1065 / Schedule C prep
5. Desktop .exe wrapper and an AI connector (MCP) that works with any assistant

## Set it up for your business

You need Node 20+ and a free Cloudflare account.

```bash
git clone https://github.com/printomancy/shopbooks && cd shopbooks
npm install
npx wrangler login
npx wrangler d1 create shopbooks            # copy the database_id it prints
cp wrangler.example.jsonc wrangler.jsonc    # paste the database_id in
npm run db:migrate:remote
npx wrangler secret put APP_PASSCODE        # the passcode you'll type on each device
npx wrangler secret put TOKEN_SECRET        # any long random string
npm run deploy
```

Open the URL it prints on your phone, tap **Add to Home screen**, then turn on sync in Settings with your passcode.

## Develop

```bash
cp wrangler.example.jsonc wrangler.jsonc    # any database_id works locally
printf 'APP_PASSCODE=dev\nTOKEN_SECRET=dev\n' > .dev.vars
npm run db:migrate:local
npm run dev
npm test
```

## Not tax advice

Shopbooks organizes your numbers and shows where they go on official forms. Printouts are worksheets, not filings. Check anything important with a tax professional.

## License

MIT
