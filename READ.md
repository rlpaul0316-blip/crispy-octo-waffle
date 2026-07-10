# Commission / Request Bot

A paid request-intake Telegram bot. Users spend credits to submit requests; you receive each one and reply or send a canned response. Every user-facing string is editable live so you can re-theme the whole bot (e.g. for promoting a creator) without redeploying.

## What it does
- `/start` → menu → **Submit a Request** (costs 1 credit) → forwarded to you
- Buy credits with **BTC**, **SOL** (manual confirm) or **Telegram Stars** (auto-credit)
- You get each submission with **Reply** and **Send Canned** buttons
- All text stored in the DB, editable with `/settext`

## Deploy on Render
1. Push these files (`index.js`, `package.json`) to a GitHub repo.
2. Render → **New → Postgres**. Copy its connection URL.
3. Render → **New → Web Service** → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
4. Add environment variables (see `.env.example`):
   - `BOT_TOKEN` — from @BotFather
   - `DATABASE_URL` — the Postgres URL from step 2
   - `ADMIN_ID` — your numeric Telegram id (get it from @userinfobot)
5. Deploy. Tables are created and default text seeded automatically on first boot.

## First-time setup (send these to your bot)
```
/setaddr btc YOUR_BTC_ADDRESS
/setaddr sol YOUR_SOL_ADDRESS
```
Optionally adjust packages (prices + Stars):
```
/setpackages [{"credits":1,"stars":50,"btc":"0.0002","sol":"0.02","label":"1 credit"}]
```

## Admin commands
| Command | Purpose |
|---|---|
| `/admin` | Show this panel |
| `/addcredits <user_id> <amount>` | Confirm a BTC/SOL payment / grant credits |
| `/pending` | List pending BTC/SOL payments (each shows the exact addcredits line) |
| `/users` | Recent users + balances |
| `/setaddr btc\|sol <address>` | Update a receiving address |
| `/setpackages <json>` | Replace credit packages |
| `/settext <key> <value>` | Edit any user-facing string (re-theming) |
| `/gettext <key>` | Show current value of a string |
| `/listtexts` | List every editable key |
| `/reply <submission_id> <text>` | DM a reply to the requester |
| `/canned <submission_id>` | Send the canned response + refund the credit |

## Re-theming
Run `/listtexts` to see every editable key, then `/settext <key> <new text>`.
Placeholders like `{credits}`, `{label}`, `{code}`, `{btc_address}`, `{id}` are filled in
automatically — keep them in the text where you want those values to appear.

Example:
```
/settext welcome 🎬 Welcome to the fan hub! You have {credits} credit(s). Submit a shoutout request below.
```

## Payment flow notes
- **Telegram Stars** are handled natively — credits are added the instant Telegram confirms.
- **BTC / SOL** are manual: the user gets your address + a ref code, you get a ping with a ready-to-paste `/addcredits` line. Verify the transaction yourself, then run it.
