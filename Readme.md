# Shopify App Backend

This is the backend (server) of our Shopify embedded app.
It has 4 jobs:

1. **Check every request.** It makes sure the request really comes from Shopify (ID token check).
2. **Do the install step.** It swaps the ID token for a long-lived "offline access token" (token exchange) and keeps it safe in MySQL.
3. **Keep the token fresh.** It refreshes the token, so we can call the Shopify Admin API at any time.
4. **Handle webhooks.** It receives Shopify webhooks (uninstall, privacy requests) and works on them safely in the background.

The React admin app is a **separate project**. This repo has only the backend.

---

## Contents

1. [Words you will see](#1-words-you-will-see)
2. [What we use](#2-what-we-use)
3. [Folder map](#3-folder-map)
4. [The big picture](#4-the-big-picture)
5. [Environments and the .env file](#5-environments-and-the-env-file)
6. [Run it locally](#6-run-it-locally)
7. [Install and login flow (token exchange)](#7-install-and-login-flow-token-exchange)
8. [Webhook flow](#8-webhook-flow)
9. [Background jobs](#9-background-jobs)
10. [Database](#10-database)
11. [All routes](#11-all-routes)
12. [Plan for extensions (theme, checkout, POS)](#12-plan-for-extensions-theme-checkout-pos)
13. [Security checklist](#13-security-checklist)
14. [Good to know and things to do later](#14-good-to-know-and-things-to-do-later)

---

## 1. Words you will see

| Word | What it means |
|---|---|
| **ID token** (also called session token) | A very short-lived token (about one minute). The React app gets it from Shopify with `shopify.idToken()`. It proves "this merchant is using the app right now". Shopify signs it with our client secret. |
| **Offline access token** | The long-lived key our server uses to call the Shopify Admin API, even when the merchant is not online. |
| **Refresh token** | Comes together with the access token. We use it to get a new access token when the old one is about to end. |
| **Token exchange** | Swapping an ID token for an offline access token and a refresh token. We do it **once per shop**, the first time the app opens. |
| **Webhook** | A message Shopify sends to our server when something happens, for example "the app was uninstalled". |
| **HMAC / signature** | A fingerprint. Shopify signs webhooks and app proxy requests with our client secret. We calculate the same fingerprint and compare. |
| **Redis lock** | A "please wait" flag for one shop. It stops two requests from exchanging or refreshing the same shop's token at the same time. |
| **Queue (BullMQ)** | A waiting line in Redis. Webhook jobs wait there until a worker does them. |

---

## 2. What we use

| Part | Tool |
|---|---|
| Language | Node.js and TypeScript |
| Web server | Express 5 (with helmet, cors, compression, morgan, express-rate-limit) |
| Database | MySQL (library: `mysql2`) |
| Locks | Redis (library: `redis`) |
| Webhook queue | BullMQ (it uses `ioredis`) |
| Timers | `cron` |
| Shopify | `@shopify/shopify-api` v15 |
| Tokens | `jsonwebtoken` |

---

## 3. Folder map

```text
database/migrations/       SQL files. 001 = stores table, 002 = webhook_events table
src/
  server.ts                Starts everything: MySQL, Redis, jobs, worker, web server
  app.ts                   The Express app: security headers, CORS, routes
  config/
    env.ts                 Reads and checks the .env file. Stops the app if something is wrong
    database.ts            MySQL pool (always works in UTC time)
    redis.ts               Redis client (used for locks)
    queue-redis.ts         Redis connections for BullMQ
    shopify.ts             Shopify library setup
  routes/                  The list of URLs (index, store, auth, webhook)
  middleware/
    verify-session-token.ts  Checks the token on every protected route
    initialize-store.ts      Store setup + token exchange. Used ONLY by GET /api/store
    error-handler.ts         Turns errors into JSON answers
    rate-limit.ts            Rate limits: /api and /webhooks (and a helper for new routes)
  controllers/             Code that answers each route
  services/
    shopify-auth.service.ts    ID token check, token exchange, refresh, encrypt and decrypt
    store.service.ts           Redis lock, ensure and refresh tokens, callAdminApi
    standalone-auth.service.ts Tokens for local testing only
    shop-details.service.ts    Reads the shop's name, time zone, plan from Shopify and saves them
    webhook.service.ts         Save and process webhooks
  repositories/
    store.repository.ts    All SQL queries
  models/store.model.ts    Types for the stores table
  queues/                  BullMQ queue (adds jobs) and worker (does jobs)
  jobs/                    Cron jobs (token keep-alive, stuck webhooks, cleanup)
```

---

## 4. The big picture

```text
   Merchant opens the app in Shopify Admin
                    |
                    v
          +--------------------+              +-----------------------+
          |  React Admin App   |              |  Shopify (webhooks)   |
          |  (App Bridge)      |              +-----------+-----------+
          +---------+----------+                          |
                    |                                     |
   Authorization: Bearer <ID token>          POST /webhooks (signed)
                    |                                     |
                    v                                     v
   +--------------------------------------------------------------+
   |                 THIS BACKEND (Express)                       |
   |   /api/*      checks the ID token                            |
   |   /webhooks   checks the HMAC signature                      |
   +-------+-------------------+--------------------+-------------+
           |                   |                    |
           v                   v                    v
        MySQL                Redis            Shopify Admin API
   (shops, tokens,      (locks, job line)    (called with the saved
    webhook events)                            offline access token)
```

---

## 5. Environments and the .env file

We have 4 environments. Two settings choose which one runs:

- `APP_ENV` says **which** environment this is. Our own code uses it.
- `NODE_ENV` says "development" or "production" mode. Express and other libraries use it.

| APP_ENV | NODE_ENV | Standalone tokens | Error details shown to the caller | Shopify credentials |
|---|---|---|---|---|
| `local` (your laptop) | `development` | **ON** | yes | development app |
| `development` (dev server) | `development` or `production` | off | yes | development app |
| `staging` | **must be** `production` | off | no | staging app (its own) |
| `production` | **must be** `production` | off | no | production app (its own) |

The app stops at start if `APP_ENV=staging` or `production` is used with a different `NODE_ENV`.

### Which file is read?

The app reads **only a file named `.env`** in the project root (`dotenv.config()` in `src/config/env.ts`).

The files `.env.local`, `.env.development`, `.env.staging` and `.env.production` are **not read by the app**. Use them as notes that show what changes on each machine:
copy the one you need into `.env` (or put the same values in your server's settings), and fill the rest from `.env.example`.

`.gitignore` already ignores `.env` and `.env.*`, except `.env.example`. **Never commit a real `.env` file or put it in a zip you share.**

### All settings

| Setting | Needed? | What it does |
|---|---|---|
| `APP_ENV` | yes | `local`, `development`, `staging` or `production` |
| `NODE_ENV` | yes | `development` or `production` |
| `PORT` | no (3000) | Port of the web server |
| `TRUST_PROXY` | no (0) | How many proxies or load balancers stand between the internet and this server. `0` = none (your laptop). `1` = one (a load balancer, or a Cloudflare Tunnel or ngrok tunnel). It decides which IP the rate limits see, so set it on purpose (see "Rate limits" in section 11) |
| `SHOPIFY_CLIENT_ID` | yes | Client ID of the Shopify app |
| `SHOPIFY_CLIENT_SECRET` | yes | Client secret of the Shopify app. Used to check ID tokens, webhooks and app proxy signatures |
| `APP_HOST` | yes | Public host of this backend, **without** `https://` |
| `DB_HOST`, `DB_USER`, `DB_NAME` | yes | MySQL connection |
| `DB_PORT` | no (3306) | MySQL port |
| `DB_PASSWORD` | no (empty) | MySQL password |
| `TOKEN_ENCRYPTION_KEY` | yes | 32-byte key (base64). Encrypts tokens in MySQL |
| `TOKEN_ENCRYPTION_KEY_ID` | no (`v1`) | Name of the active key. Change it when you rotate the key |
| `TOKEN_ENCRYPTION_OLD_KEYS` | no | Old keys, only to read old tokens. Format: `v1=base64key,v0=base64key` |
| `STANDALONE_TOKEN_SECRET` | only when `APP_ENV=local` | Secret for local test tokens |
| `STANDALONE_TOKEN_TTL_DAYS` | no (30) | How long a local test token lives (1 to 365 days) |
| `REDIS_URL` | no (`redis://127.0.0.1:6379`) | Redis address |
| `CORS_ORIGINS` | no (empty) | Websites that may call `/api` from a browser. Comma separated, for example the origin of your React app |

Make a new encryption key (or any 32-byte secret) with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

---

## 6. Run it locally

### You need

- Node.js 20 or newer
- MySQL 8
- Redis
- A Shopify app (client ID and client secret) and a development store
- A public HTTPS address that points to your laptop (a tunnel such as Cloudflare Tunnel or ngrok). Shopify needs it to send webhooks and to load your app.

### Steps

1. **Install packages**
   ```bash
   npm install
   ```

2. **Create the database** (use your own `DB_NAME`)
   ```sql
   CREATE DATABASE delivery_date_app CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
   ```

3. **Create the tables.** Run the migration files **in order**. There is no migration tool yet, so run them by hand:
   ```bash
   mysql -u root -p delivery_date_app < database/migrations/001_create_stores.sql
   mysql -u root -p delivery_date_app < database/migrations/002_create_webhook_events.sql
   ```

4. **Create your `.env` file.** Copy `.env.example` to `.env`, then set at least:
   ```text
   APP_ENV=local
   NODE_ENV=development
   SHOPIFY_CLIENT_ID=...
   SHOPIFY_CLIENT_SECRET=...
   APP_HOST=your-tunnel-host.example.com
   DB_HOST=127.0.0.1
   DB_USER=root
   DB_PASSWORD=...
   DB_NAME=delivery_date_app
   TOKEN_ENCRYPTION_KEY=<make one with the command in section 5>
   STANDALONE_TOKEN_SECRET=<make one with the same command>
   ```

5. **Start Redis** (on port 6379, or set `REDIS_URL`).

6. **Start the tunnel** and use its address as `APP_HOST`. A tunnel is a proxy, so also set `TRUST_PROXY=1` in your `.env`. Without it, the rate limit library warns about the `X-Forwarded-For` header. The same address must be set in the Shopify app settings (app URL and webhook address). Those settings live in your Shopify app configuration, not in this repo.

7. **Start the backend**
   ```bash
   npm run dev
   ```
   You should see these lines:
   ```text
   MySQL connected
   Redis connected
   Stale-token refresh job scheduled
   Stuck-webhook sweeper scheduled
   Webhook cleanup job scheduled
   Webhook worker started
   Server listening on port 3000 (local)
   ```

8. **Check it works**: open `http://localhost:3000/health`. You should see `{"status":"ok"}`. Then open `http://localhost:3000/ready`. You should see `{"status":"ready","checks":{"mysql":"ok","redis":"ok"}}`. If it says `not_ready`, MySQL or Redis is not working.

### npm commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and restarts it when you change a file. It does **not** check types |
| `npx tsc --noEmit` | Checks types only. Run it before you commit |
| `npm run build` | Builds to the `dist` folder |
| `npm start` | Runs the built app (`node dist/server.js`) |

### Test without opening Shopify Admin (standalone token)

Only when `APP_ENV=local`. A standalone token lets you call the API from Postman or curl.

1. Open the app once in Shopify Admin, so `GET /api/store` runs and the shop exists in MySQL.
2. Call `GET /api/auth/standalone-token` with a **real** ID token. It returns `{ shopDomain, standaloneToken }`.
3. Use it in Postman: `Authorization: Bearer <standaloneToken>`.
4. If one leaks, call `POST /api/auth/standalone/revoke`. All old standalone tokens stop working at once.

Rules: a standalone token cannot do a token exchange, it cannot create a new standalone token, and it is rejected in every environment except `local`.

### Common errors when starting

| Message | What to do |
|---|---|
| `APP_ENV must be one of local, development, staging, production` | Add `APP_ENV=local` to `.env` |
| `NODE_ENV must be set to exactly "development" or "production"` | Fix `NODE_ENV` |
| `APP_ENV=staging requires NODE_ENV=production` | Set `NODE_ENV=production` |
| `Missing required environment variable: ...` | Add that setting to `.env` |
| `Encryption key "v1" must decode to exactly 32 bytes (base64)` | Make a new key with the command in section 5 |
| `Database session time zone must be UTC` | Rare. The app sets UTC for every connection. Check your MySQL setup |
| MySQL error `ER_NO_SUCH_TABLE` | Run the migration files (step 3) |
| Redis connection errors in the log | Start Redis, or check `REDIS_URL` |

---

## 7. Install and login flow (token exchange)

### 7.1 The story in simple words

1. The merchant installs the app. Shopify handles the install (managed installation).
2. Shopify opens our React app inside the Shopify Admin.
3. For **every** call to our backend, the React app asks Shopify for a fresh ID token (`shopify.idToken()`) and sends it as `Authorization: Bearer <ID token>`.
4. The **first** call is always `GET /api/store`. The backend checks the ID token, creates the shop row in MySQL if it is missing, and does the **token exchange** if the shop has no offline token yet. The tokens are encrypted and saved.
5. Every other call only **checks** the ID token. If the controller needs the Shopify Admin API, it asks for the saved token. If that token is about to end, the backend refreshes it first.

The token exchange happens in **one place only**: `GET /api/store`.

We wait at most **10 seconds** for Shopify to answer the exchange. After that the request ends with a 504, the Redis lock is released, the failure is saved on the shop row, and the next try starts a new exchange. A request that arrives while another request does the first exchange waits for it (up to 12 seconds).

### 7.2 Diagram: the first API (`GET /api/store`)

```text
                         SHOPIFY ADMIN
                               |
                               v
                       React Admin App
                               |
                               |  shopify.idToken()   (a fresh token for every call)
                               v
                      +------------------+
                      | Shopify ID Token |
                      +--------+---------+
                               |
                               v
                GET /api/store   (FIRST API. Wait for it to finish)
                               |
                               v
                     verifySessionToken
          (checks signature, audience, time. No database)
                    |                       |
               bad token                good token
                    |                       |
                    v                       v
        401 + retry header           initializeStore
     (App Bridge asks Shopify               |
      for a new token and retries)          v
                                 Find or create the shop in MySQL
                                            |
                                            v
                                Offline token saved in the DB?
                                    |                  |
                                   NO                 YES
                                    |                  |
                                    v                  |
                            Take the Redis lock        |
                                    |                  |
                                    v                  |
                           Check again (another        |
                           request may be done)        |
                                    |                  |
                                    v                  |
                          Token exchange with Shopify  |
                                    |                  |
                                    v                  |
                          Encrypt and save both tokens |
                                    |                  |
                                    v                  |
                           Release the Redis lock      |
                                    |                  |
                                    +--------+---------+
                                             |
                                             v
                                  Store controller (getCurrentShop)
                                             |
                                             v
                                      Return store info
```

### 7.3 Diagram: every other API (for example `PATCH /api/store/onboarding`)

```text
   React app  (only after GET /api/store has worked)
        |
        |  shopify.idToken()
        v
   Other API request
        |
        v
   verifySessionToken ----- bad token -----> 401 + retry header
        |
     good token
        |
        v
   Controller
        |
        v
   Needs the Shopify Admin API?
        |                      |
       NO                     YES
        |                      |
        v                      v
   Use local             callAdminApi()
   MySQL data            -> getValidOfflineAccessToken()
        |                      |
        |                      v
        |            Is the saved access token still good?
        |                |                          |
        |              VALID                  EXPIRED, or ends within 60 seconds
        |                |                          |
        |                |                          v
        |                |                  Take the Redis lock
        |                |                          |
        |                |                          v
        |                |                  Read the token from the DB again
        |                |                          |
        |                |                          v
        |                |                  Is a refresh still needed?
        |                |                      |              |
        |                |                     NO             YES
        |                |                      |              |
        |                |                      |              v
        |                |                      |      Refresh with Shopify
        |                |                      |      (if the refresh token is dead AND we
        |                |                      |       have the ID token: new token exchange)
        |                |                      |              |
        |                |                      |              v
        |                |                      |      Encrypt and save new tokens
        |                |                      |              |
        |                |                      +------+-------+
        |                |                             |
        |                |                             v
        |                |                     Release the Redis lock
        |                |                             |
        |                +--------------+--------------+
        |                               |
        |                               v
        |                    Call Shopify Admin API  (15 second limit)
        |                               |
        |                    Answer is 401? Refresh once, try once more
        |                               |
        +---------------+---------------+
                        |
                        v
                Return API response
```

### 7.4 Which code does each step

| Step | File and function |
|---|---|
| Read the `Bearer` token, check it | `middleware/verify-session-token.ts` -> `verifySessionToken` |
| Check signature, audience, time, `iss` and `dest` | `services/shopify-auth.service.ts` -> `validateIdToken` |
| Shop name comes from the token (`dest` claim) | `shopDomainFromIdToken` |
| Find or create the shop, do the exchange | `middleware/initialize-store.ts` -> `initializeStore`, then `services/store.service.ts` -> `ensureOfflineToken` |
| Talk to Shopify for the exchange | `shopify-auth.service.ts` -> `exchangeOfflineToken` |
| Encrypt and save | `encryptToken` and `repositories/store.repository.ts` -> `saveOfflineToken` (new exchange) or `saveRefreshedTokens` (refresh) |
| Get a valid token for an Admin API call | `store.service.ts` -> `getValidOfflineAccessToken` |
| Refresh | `store.service.ts` -> `refreshWithLock` and `performRefresh`, `shopify-auth.service.ts` -> `refreshOfflineToken` |
| Call the Admin API with retry on 401 | `store.service.ts` -> `callAdminApi` |

### 7.5 Rules for the React app

1. Call **`GET /api/store` first** and **wait** for it to finish. Do not start other API calls at the same time.
2. Send a fresh `Authorization: Bearer <await shopify.idToken()>` on every call.
3. If any other call answers **409** (`Store is not set up yet. Call GET /api/store first.`), call `GET /api/store` once, then try the first call again once.

### 7.6 Errors the frontend can get

| Status | When | What the frontend should do |
|---|---|---|
| **401** with header `X-Shopify-Retry-Invalid-Session-Request: 1` | The ID token is missing a good signature, expired, or Shopify rejected it during the exchange | Get a new ID token and try again. App Bridge does this for you with this header |
| **401** without that header | No token, or a bad standalone token | Fix the request |
| **404** | `GET /api/auth/standalone-token` outside `local`, or the shop is missing | Check the environment, or call `GET /api/store` first |
| **409** | The shop or its token is not set up yet | Call `GET /api/store`, then try again |
| **429** | Too many requests from one IP (rate limit) | Wait the number of seconds in the `Retry-After` header, then try again |
| **502** | Shopify still said 401 after we refreshed the token | Show "Please reopen the app" |
| **504** | Shopify did not answer in time (15 seconds for an Admin API call, 10 seconds for the token exchange) | Show "Shopify is slow, try again later". For `GET /api/store`, try it again |
| **500** | Any other error | In `local` and `development` the message is shown. In `staging` and `production` it is always `Internal server error`. See the server log |

### Log lines for errors

Every error that reaches `middleware/error-handler.ts` writes **one** entry in the log:

| Log entry | Level | Meaning |
|---|---|---|
| `[http] 409 PATCH /api/store/onboarding shop=abc.myshopify.com - Store is not set up yet. ...` | warning | An **expected** answer (any 4xx, for example 409, 400 bad JSON, 413 body too big). One short line, **no stack** |
| `[http] 500 GET /api/store shop=abc.myshopify.com` and then the error with its stack | error | A **real problem** (5xx, including 502 and 504 from Shopify). Look at it |

- The log never contains the query string (it can hold private data).
- A **401** from the login check and a **429** from the rate limit are answered directly. They never reach the error handler, so they are not logged there.
- The answer the caller gets is not changed by this.

### 7.7 How tokens are kept safe

- Tokens are encrypted with **AES-256-GCM** before they go into MySQL.
- Each saved token starts with the key name, for example `v1:...`. Tokens saved before this feature have no prefix and are read as `v1`.
- The key itself lives only in the environment, never in MySQL.

**Rotate the key**

1. Make a new key.
2. Change 3 settings. The old key moves to the OLD list:
   ```text
   TOKEN_ENCRYPTION_KEY=<new key>
   TOKEN_ENCRYPTION_KEY_ID=v2
   TOKEN_ENCRYPTION_OLD_KEYS=v1=<the old key>
   ```
3. Restart. New tokens use `v2`. Old tokens still open with `v1`.
4. Tokens move to the new key by themselves, because every refresh saves new tokens with the active key.
5. See what is left, and remove the old key when no `v1` is left:
   ```sql
   SELECT token_encryption_key_id, COUNT(*) FROM stores
   WHERE access_token_encrypted IS NOT NULL GROUP BY token_encryption_key_id;
   ```
6. If a key leaked, do not wait. Rotate now and ask merchants to reopen the app, or re-encrypt every row with a one-time script.
# Important about your current setup

# Keep TOKEN_ENCRYPTION_KEY_ID=v1 with your current key the first time you use this code. That way nothing changes for tokens you already have. If your real .env has a different id such as v2 and you already saved tokens, tell me first, because old tokens would be read with the wrong key id.


### 7.8 Token refresh

- The access token is short-lived. Its end time is saved in `access_token_expires_at`. The backend refreshes it when it ends within **60 seconds**.
- The refresh token also ends. Its time is saved in `refresh_token_expires_at` (the code treats about 90 days as the limit).
- A **daily job** (03:00) refreshes every shop whose refresh token ends within 14 days. This keeps quiet shops alive.
- If the refresh token is dead:
  - **While the merchant has the app open:** we have their ID token, so we do a new token exchange.
  - **In the background job:** we have no ID token, so it fails. The merchant must open the app again.
- Every failed token step is saved on the shop row. To see broken shops:
  ```sql
  SELECT shop_domain, last_token_exchange_at, last_token_exchange_error
  FROM stores
  WHERE installation_status IN ('installed', 'reinstalled')
    AND last_token_exchange_status = 'failed'
  ORDER BY last_token_exchange_at DESC;
  ```
  - `...merchant must reopen the app` means the connection is really broken.
  - `...: retry` means Shopify was busy or not reachable. It tries again later.

### 7.9 Uninstall and reinstall

```text
 (no row)                                   GET /api/store creates the row
    |                                                    |
    v                                                    v
  pending  ------------ token exchange success ---->  installed
                                                         |
                                       app/uninstalled webhook (tokens are erased)
                                                         |
                                                         v
                                                    uninstalled
                                                         |
                          merchant installs again, GET /api/store does a new exchange
                                                         |
                                                         v
                                                   reinstalled
```

- On `app/uninstalled`, the tokens are erased and the shop is marked `uninstalled`.
- Shopify does not promise the order of webhooks. A late uninstall webhook that is **older** than the last install is ignored, so it cannot erase new tokens. A refresh is not an install, so it does not move `last_installed_at`. A refresh that finishes after the shop was uninstalled saves nothing.
- About 48 hours after an uninstall, Shopify sends `shop/redact`. We delete the shop row **only** if the shop is `uninstalled` or `pending`. If the merchant already came back, the row is kept.

### 7.10 Shop details (name, time zone, plan)

We read the shop's details from Shopify and save them in the `stores` table. **No extra column is needed.**

| Column | Filled from |
|---|---|
| `shopify_shop_id` | the shop `id` |
| `shop_name`, `shop_email`, `contact_email` | `name`, `email`, `contactEmail` |
| `currency_code`, `timezone` | `currencyCode`, `ianaTimezone` (the picker needs the time zone for cut-off times) |
| `shopify_plan_name` | `plan.publicDisplayName` (for example `Basic`, `Plus`, `Development`) |
| `shopify_plan_type` | `development` (a partner test shop), `plus`, or `standard` |
| `is_shopify_plus` | true when the plan name is `Plus` (change `PLUS_PLAN_NAMES` in the service if `Plus Trial` should count too) |
| `shop_created_at` | `createdAt` |
| `shop_updated_at` | **the time of our last save**, so you can see how fresh the details are |

| When | What happens |
|---|---|
| First install (right after the token exchange) | We read the details and **wait** (up to 5 seconds), so the very first `GET /api/store` answer already has the shop name. If Shopify fails, the install still works |
| Every later `GET /api/store` | If the details are missing or older than 24 hours, we read them again **in the background**. The page is not slowed down. We try at most once every 5 minutes per shop, even if Shopify keeps failing |
| `shop/update` webhook | We read the details again, at most once a minute per shop. Shopify can send this webhook often (even for changes that are not about the name or time zone), so extra events only mark the saved details as old. The next `GET /api/store` then reads them again |

There is no webhook for "app installed", so the read at install is needed. The webhook only keeps the data fresh.

How we know the details are fresh without a column: short-lived keys in Redis.

| Redis key | Lives for | Meaning |
|---|---|---|
| `shop-details:fresh:<shop>` | 24 hours | The details were saved well. Do not read again yet |
| `shop-details:cooldown:<shop>` | 5 minutes | We just tried. Wait before the next try |
| `shop-details:webhook-guard:<shop>` | 1 minute | A `shop/update` was just handled |

If Redis is emptied, the details are simply read once more. Nothing breaks.

To receive `shop/update`, add the topic to your Shopify app configuration (`shopify.app.toml`) and deploy:

```toml
[[webhooks.subscriptions]]
topics = [ "shop/update" ]
uri = "/webhooks"
```

---

## 8. Webhook flow

Webhooks come to `POST /webhooks`. This route reads the **raw text** body, because the signature is made from the raw text. Never put `express.json()` in front of it.

### 8.1 Diagram

```text
   Shopify  -- POST /webhooks -->  raw body + headers
                                         |
                                         v
                              Check the HMAC signature --- bad ---> 401
                                         |
                                       good
                                         v
                                  Parse the JSON ------- bad ---> 400
                                         |
                                         v
                  Save in MySQL: webhook_events, status = received
                      |                  |                    |
                 database error     duplicate id or       saved OK
                      |             unknown shop              |
                      v                  |                    v
                    500                  v            Answer 200 to Shopify
              (Shopify will retry)  Nothing more to do        |
                                    (answer is still 200)     v
                                                    Add a job to the BullMQ queue
                                                    (the job holds only the row id)
                                                              |
                                                              v
                                                     Worker takes the job
                                                     (5 at a time, 5 tries)
                                                              |
                                                              v
                                              Read the row from MySQL, work by topic
                                                              |
                                                +-------------+--------------+
                                             success                       error
                                                |                            |
                                      status = completed        status = failed + error text
                                                                  BullMQ tries again after
                                                                  2s, 4s, 8s, 16s
```

### 8.2 Why it works this way

- **Save first, answer second.** The event is safe in MySQL before we say 200. If saving fails, we answer 500 and Shopify sends it again.
- **No double work.** `X-Shopify-Webhook-Id` is unique in MySQL, so the same webhook is saved only once. The queue job id is `webhook-event-<row id>`, so one row never runs twice at the same time.
- **Only the row id goes in the queue.** Redis keeps job data in plain text. Some payloads hold a person's email and phone, so the real payload stays in MySQL.
- **Slow work never blocks Shopify.** The worker does the work after we answered.

### 8.3 What each topic does

| Topic (as stored) | What the code does |
|---|---|
| `APP_UNINSTALLED` | Marks the shop `uninstalled` and erases the tokens (ignored if older than the last install) |
| `SHOP_REDACT` | Deletes the shop row if it is `uninstalled` or `pending` (this also deletes its webhook rows) |
| `CUSTOMERS_DATA_REQUEST` | Writes a log line (the app stores no customer data today), then wipes the saved payload |
| `CUSTOMERS_REDACT` | Writes a log line (the app stores no customer data today), then wipes the saved payload |
| `SHOP_UPDATE` | Reads the shop details again from Shopify and saves them (see 7.10). Skipped quietly if the shop has no token |
| any other topic | Nothing to do. Marked `completed` |

The library writes topics in capital letters with underscores: `app/uninstalled` becomes `APP_UNINSTALLED`.

> **Do this when the date picker starts storing customer data** (for example a delivery date linked to an order or customer): make `CUSTOMERS_DATA_REQUEST` and `CUSTOMERS_REDACT` really export and delete that data. Today they only log.

### 8.4 When things go wrong

| Problem | What happens |
|---|---|
| Redis is down when a webhook arrives | We already said 200. The row stays `received`. The **sweeper** (every 2 minutes) finds rows older than 5 minutes and queues them again |
| The worker fails | BullMQ tries 5 times in total (2s, 4s, 8s, 16s between tries). The row shows `failed` with the error text |
| All 5 tries failed | The row stays `failed`. **Nothing tries again by itself.** Look at it and fix it by hand (SQL below) |
| A webhook comes for a shop we do not know | It is logged and ignored. The answer is still 200 |
| A row is still `received` or `processing` after 90 days | The cleanup job deletes it and writes a **WARNING** to the log. If it was a privacy webhook, that request was missed. Watch your logs |

Find events that need a person:

```sql
SELECT id, topic, shop_domain, received_at, error
FROM webhook_events
WHERE status = 'failed'
ORDER BY received_at DESC;
```

### 8.5 Test webhooks locally

Webhooks need the public tunnel address. You can send test webhooks with the Shopify CLI (check the Shopify CLI docs for the exact `shopify app webhook trigger` options). Then look at `webhook_events` in MySQL and at the log lines starting with `[webhook-worker]`.

Webhook subscriptions (which topics we get) are set in the Shopify app configuration, not in this repo. The three privacy topics `customers/data_request`, `customers/redact` and `shop/redact` must be set.

---

## 9. Background jobs

All jobs start in `server.ts`. The times use the **server's time zone**.

| Job | When | What it does |
|---|---|---|
| `refresh-stale-tokens` | every day 03:00 | Refreshes the token of shops whose refresh token ends within 14 days. Waits 250 ms between shops |
| `requeue-stuck-webhooks` | every 2 minutes | Queues again the events that stayed `received` for more than 5 minutes |
| `cleanup-webhook-events` | every day 04:00 | Deletes `completed` events older than 30 days. Deletes `failed`, `received` and `processing` events older than 90 days (and warns about the last two) |

The webhook worker (5 jobs at the same time) runs inside the same process as the web server.

### Shutdown (Ctrl+C, SIGTERM)

When the server gets `SIGINT` or `SIGTERM`, it stops in this order:

1. It stops the 3 cron jobs, so no new run starts.
2. It stops the web server (no new connections, running requests may finish) and the webhook worker (the job it is running now is finished, no new job is taken).
3. It closes the queue, the Redis connections and the MySQL pool. Then it exits with code 0.

Rules:

- A **second signal** is ignored (it only writes a log line). Shutdown never runs twice.
- If the shutdown is not finished after **10 seconds** (for example a request that never ends), the server writes `forcing exit` and exits with code 1.
- A webhook job that was cut off is not lost. The event is saved in MySQL as `received`, and the sweeper queues it again.

Your process manager must wait **longer than 10 seconds** before it kills the process:

| Where | Setting | Default | Set it to |
|---|---|---|---|
| Docker | `docker stop` waits, or `stop_grace_period` in Docker Compose | 10 seconds | 15 seconds |
| PM2 | `kill_timeout` | 1.6 seconds | 15000 (milliseconds) |
| Kubernetes | `terminationGracePeriodSeconds` | 30 seconds | the default is fine |

---

## 10. Database

### `stores` (one row per shop)

| Group | Main columns |
|---|---|
| Identity | `store_id`, `shop_domain` (unique), `shop_name`, `shop_email` |
| Install state | `installation_status` (`pending`, `installed`, `reinstalled`, `uninstalled`), `app_status`, `installed_at`, `last_installed_at`, `uninstalled_at` |
| Onboarding | `onboarding_completed`, `onboarding_completed_at` (set once, the first time) |
| Tokens | `access_token_encrypted`, `access_token_expires_at`, `refresh_token_encrypted`, `refresh_token_expires_at`, `token_encryption_key_id` |
| Token health | `last_token_exchange_at`, `last_token_exchange_status` (`success` or `failed`), `last_token_exchange_error` |
| Local testing | `standalone_token_version` (raise it to revoke all standalone tokens) |
| App settings | `storefront_enabled`, `settings_json` |
| Plan and billing | `app_plan`, `app_plan_status`, `billing_status`, `shopify_subscription_id` and more |

### `webhook_events` (one row per webhook)

| Column | Meaning |
|---|---|
| `shopify_webhook_id` | Unique. Stops the same webhook being saved twice |
| `topic`, `shop_domain`, `payload` | What Shopify sent |
| `triggered_at` | When Shopify says it happened |
| `status` | `received` (saved), `completed`, `failed`. (`processing` exists in the table but the code does not use it yet) |
| `error` | Error text when it failed |

It has an index on `(status, received_at)` that makes the sweeper and the cleanup job fast. When a shop is deleted, its webhook rows go with it.

### Time

All times are saved in **UTC**. The MySQL pool uses `timezone: 'Z'` and sets `time_zone = '+00:00'` for every connection. The app stops at start if the session is not UTC.

---

## 11. All routes

| Route | Who calls it | How it is checked | Notes |
|---|---|---|---|
| `GET /health` | anyone | nothing | "The process is running." Returns `{"status":"ok"}`. It never checks MySQL or Redis, on purpose. Use it to decide if the app must be restarted |
| `GET /ready` | anyone | nothing | "The app can do its work." Checks MySQL and Redis (2 seconds at most for each). Answers 200 `ready`, or 503 `not_ready` with `mysql` and `redis` each `ok` or `down`. The answer is kept for 3 seconds. Use it for a load balancer |
| `POST /webhooks` | Shopify | HMAC signature | Raw body. See section 8 |
| `GET /api/store` | React app | ID token, then `initializeStore` | **First API.** Creates the shop, does the token exchange, and reads the shop details (7.10). Returns store info |
| `PATCH /api/store/onboarding` | React app | ID token | Marks onboarding done. Answers 409 if the shop row does not exist yet |
| `GET /api/store/me/admin-api-example` | React app | ID token | Example of a safe Admin API call with `callAdminApi` |
| `GET /api/auth/standalone-token` | React app (local only) | ID token (real session only) | 404 unless `APP_ENV=local` |
| `POST /api/auth/standalone/revoke` | React app or Postman | ID token or standalone token | Makes all old standalone tokens invalid |

### Add a new route the safe way

- Put it **below** `router.use(verifySessionToken)` in the routes file. Then the token is always checked first.
- **Only** `GET /api/store` should use `initializeStore`. If another route must be allowed to be the first call for a shop (for example for a POS extension), add `initializeStore` to that route, but only **after** `verifySessionToken`:
  ```ts
  router.use(verifySessionToken);
  router.get('/', initializeStore, getCurrentShop);
  router.get('/pos/summary', initializeStore, posSummary); // example: also allowed to set up a shop
  ```
  If `initializeStore` runs **before** `verifySessionToken`, the route has no login check at all.
- When a controller needs the Shopify Admin API, always call it through `callAdminApi`, and add `signal: AbortSignal.timeout(...)` to the `fetch`.

### Rate limits

| Where | Limit | What counts |
|---|---|---|
| Everything under `/api` (React admin app) | 300 requests per minute per IP | every request |
| `POST /webhooks` | 50 per 10 minutes per IP | **only failed requests** (bad signature, bad body, too big). Good Shopify webhooks are never counted |
| `/health`, `/ready` | no limit | |

When a limit is reached, the server answers **429** with `{ "error": "Too many requests. Please try again later." }` and the headers `Retry-After` and `RateLimit`.

The limits live in `src/middleware/rate-limit.ts`. For the new public routes (`/proxy`, `/ext`), make a limiter with `createRateLimiter` and put it in front of them.

**`TRUST_PROXY` must be right.** The limit counts by IP. Behind a proxy, the real client IP is in the `X-Forwarded-For` header.

| Setting | What happens |
|---|---|
| `TRUST_PROXY=0` but a proxy is in front | Every client looks like the proxy's IP. They all share **one** counter. A few bad requests can block everyone (also real Shopify webhooks until the window ends). The library writes a warning in the log |
| `TRUST_PROXY=1` and exactly one proxy is in front | Correct. A client cannot fake its IP by sending its own `X-Forwarded-For` |
| A number bigger than the real number of proxies | Clients can fake their IP and escape the limit |

Good to know:

- The counts are kept in the memory of one server. If you run several copies, each copy counts on its own, so the real limit is bigger. Use a Redis store if you need one shared count.
- A server restart resets the counts.
- A webhook IP that sends more than 50 failed requests in 10 minutes is blocked for the rest of that window, **even for valid webhooks**. Shopify retries a webhook that gets a 429, so nothing is lost for a short block.

### Health checks: which one to use

| Route | Question it answers | Use it for |
|---|---|---|
| `GET /health` | Is the process running? | Restart decisions (Docker, Kubernetes liveness probe, PM2) |
| `GET /ready` | Can the app do its work (MySQL and Redis answer)? | A load balancer or Kubernetes readiness probe: stop sending traffic to a server that cannot work |

Do not use `/ready` for restart decisions. If MySQL is down for a while, restarting the server does not help.

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /health, port: 3000 }
readinessProbe:
  httpGet: { path: /ready, port: 3000 }
  periodSeconds: 10
```

If your hosting platform allows only one health check path, use `/health`.

`/ready` is public. It only says `ok` or `down` for each part, never an error text or an address. The reason of a failure goes to the server log (lines starting with `[ready]`).

---

## 12. Plan for extensions (theme, checkout, POS)

We plan to build a theme app extension with a date picker. We also plan POS and checkout extensions. Each one reaches the backend in a different way.

### 12.1 Who calls the backend and how it is checked

| Caller | How it reaches your backend | How the backend checks it | Token exchange? |
|---|---|---|---|
| React admin app | `Authorization: Bearer <ID token>` | `verifySessionToken` (we have this) | only in `GET /api/store` |
| Theme app extension (storefront) | through the App Proxy | the `signature` HMAC in the URL | not possible: there is no ID token |
| Checkout extension | `fetch` with a session token (needs the `network_access` setting), or through the App Proxy | check the JWT, trust only its claims | not needed |
| POS extension | `shopify.session.getSessionToken()`, which gives an OpenID Connect ID token for the Authorization header | check the JWT | not needed |

### 12.2 What to build

- **App Proxy (theme extension).** Shopify adds a `signature` parameter, a SHA-256 HMAC of the other parameters, so our server can confirm the request came from Shopify. The installed Shopify library already has this check: `shopify.utils.validateHmac(query, { signator: 'appProxy' })` (it is in the installed v15). We need to write one new middleware, `verifyAppProxy`. If the shop has no store row, return `{ enabled: false }` with status 200, not a 409.
- **Checkout and POS.** We need a second token check for extension tokens. Most of `validateIdToken` can be reused. But we have not confirmed that these tokens always follow our rule "`iss` host equals `dest` host", so **test with a real token** before relying on it.
- **CORS must change for these routes.** Extensions run in a web worker whose origin can change without notice, so our server must always answer with `Access-Control-Allow-Origin: *`. Today `app.ts` only allows the origins in `CORS_ORIGINS`. Keep that strict setting for the admin routes, and use `*` only on the extension routes.
- **Never trust the query string on public routes.** A session token only proves its own claims, and requests can come from anywhere on the internet. Use `dest` from the token for the shop and `sub` for the customer. Do not use `?shop=` or `?customer_id=` unless the signature was checked.
- **Rate limiting now matters.** It was a small item before. It becomes important because these routes are public. It is done for `/api` and `/webhooks`, and `TRUST_PROXY` is set in `.env` (section 11). For the new routes, make a limiter with `createRateLimiter` and put it in front of them.

### 12.3 Planned route layout

```text
/api/store, /api/...   -> React admin app   (ID token, strict CORS)   [exists]
/proxy/...             -> theme extension   (App Proxy signature)
/ext/...               -> checkout + POS    (session token, CORS *)
```

### 12.4 Option: use metafields

Shopify suggests that instead of making an external call from checkout, you can read the data from a **metafield**, which our app can write ahead of time with the Admin API.

Our picker settings (blocked days, cut-off time, and so on) change rarely. When the merchant saves them in admin, we could also write them to a shop metafield. Then the extensions read the settings without calling our backend. This means:

- fewer public routes to protect,
- no CORS work,
- faster pages.

It does **not** work for live data, such as "how many slots are left on this date". For that we need a backend call.

### 12.5 Check before you build

- Third-party guides say checkout UI extensions on the information, shipping and payment steps need **Shopify Plus**, while the thank-you and order-status pages are open to other plans. Confirm this in Shopify's own docs. If it is true, most merchants will use the theme app extension, and the checkout extension will be mainly for Plus stores.
- Checkout extensions need the `network_access` setting (and Shopify's approval for it, which is automatic) before they can call an external server.

---

## 13. Security checklist

- Every `/api` route checks the ID token: HS256 signature with the client secret, the `aud` claim equals our client ID, 10 seconds of clock difference allowed, and `iss` and `dest` must have the same host.
- Webhooks are checked with the HMAC signature before we read them.
- Rate limits are on `/api` and `/webhooks`. `TRUST_PROXY` must match the real number of proxies in front of the server.
- Tokens are encrypted in MySQL (AES-256-GCM). The key is only in the environment.
- Standalone tokens exist **only** when `APP_ENV=local`.
- In `staging` and `production`, errors never show their message to the caller.
- Security headers (helmet) are on. Only Shopify Admin may put the app in an iframe (`frame-ancestors`).
- Webhook payloads with personal data are wiped after they are handled, and job data in Redis holds only a row id.
- `.env` files are ignored by git. **Do not commit them, and do not put them in zip files you share.**
- Use **different** keys, secrets and Shopify credentials for staging and production.

---

## 14. Good to know and things to do later

### Good to know

- Only `.env` is read. `.env.local`, `.env.development`, `.env.staging` and `.env.production` are notes, not auto-loaded files (section 5).
- There are two ways to save tokens. A **refresh** uses `saveRefreshedTokens`: it changes only the tokens and the token health columns. It never changes `installation_status`, `last_installed_at` or `last_seen_at`, and it never saves tokens for an uninstalled shop. A **new token exchange** (first install, reinstall, or the fallback when the refresh token is dead) uses `saveOfflineToken`, which counts as an install and moves `last_installed_at`.
- The webhook sweeper only picks up `received` rows. A webhook that failed all 5 tries stays `failed` until you look at it.
- `GET /health` only says the process is running (on purpose, so a short MySQL or Redis problem does not restart a healthy server). Use `GET /ready` to check MySQL and Redis.
- Webhook bodies bigger than 100 KB are refused with **413** (the default limit of the text parser on `POST /webhooks`). Shopify would see an error and retry.
- The worker and the cron jobs run inside the web server process. If you run several copies of the server, every copy runs the cron jobs. This is safe today (locks and unique job ids stop double work), but it is wasted work.

### To do later

- A migration tool (today the SQL files are run by hand).
- Automated tests (a test with a real MySQL would catch SQL mistakes that TypeScript cannot see).
- `verifyAppProxy` and the `/proxy` and `/ext` routes (section 12).
- A Docker Compose file for MySQL and Redis, to make local setup easier.
- Real deletion code for `CUSTOMERS_DATA_REQUEST` and `CUSTOMERS_REDACT` once customer data is stored.
- Check the shop query (section 7.10) in Shopify's GraphiQL with your API version once. Shopify's docs for newer versions list `plan.publicDisplayName` instead of `plan.shopifyPlus`.
- Raise the webhook body limit (for example `text({ type: '*/*', limit: '1mb' })`).
- A `typecheck` script, and replace `ts-node-dev` with `tsx` (it brings 3 high-severity warnings in `npm audit`, in dev tools only).