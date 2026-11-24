# Shopify App Backend

This is the backend (server) of our Shopify embedded app.
It has 5 jobs:

1. **Check every request.** It makes sure the request really comes from Shopify (ID token check).
2. **Do the install step.** It swaps the ID token for a long-lived "offline access token" (token exchange) and keeps it safe in MySQL.
3. **Keep the token fresh.** It refreshes the token, so we can call the Shopify Admin API at any time.
4. **Handle webhooks.** It receives Shopify webhooks (uninstall, privacy requests) and works on them safely in the background.
5. **Let our own support staff look at a shop.** Staff log in with a username, a password and a 2FA code. Then they can open one shop ("Open as merchant"). A staff member with the role `support` can only read there. A staff member with the role `admin` can also change data. See sections 15, 16 and 17.

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
15. [Staff login and support access ("Open as merchant")](#15-staff-login-and-support-access-open-as-merchant)
16. [Postman examples (staff login and support)](#16-postman-examples-staff-login-and-support)
17. [Things to know (staff login and support)](#17-things-to-know-staff-login-and-support)

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
| **Staff user** | A person from our own company (role `support` or `admin`). Not a merchant. Staff log in with a username, a password and a 2FA code. |
| **2FA / TOTP** | The 6-digit code from an authenticator app (for example Google Authenticator). It changes every 30 seconds. |
| **Support session ("Open as merchant")** | A look at one shop, for our staff, with a support token. The role `support` can only read. The role `admin` can also change data. |
| **Support token** | A short token for ONE shop. It ends when the staff login ends. It can read (GET and HEAD). Only the role `admin` can also change data with it. |
| **session_version** | A number on every staff row. Raising it stops all sessions and support tokens of that user at once. |

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
| Staff passwords | `argon2` (argon2id) |
| Staff 2FA codes | `otplib` and `qrcode` |
| Staff cookie | `cookie-parser` |

---

## 3. Folder map

```text
database/migrations/       SQL files. 001 = stores, 002 = webhook_events, 003 = staff_users
src/
  server.ts                Starts everything: MySQL, Redis, jobs, worker, web server
  app.ts                   The Express app: security headers, CORS, routes (/api, /webhooks, /internal)
  config/
    env.ts                 Reads and checks the .env file. Stops the app if something is wrong
    database.ts            MySQL pool (always works in UTC time)
    redis.ts               Redis client (used for locks)
    queue-redis.ts         Redis connections for BullMQ
    shopify.ts             Shopify library setup
  routes/                  The list of URLs (index, store, webhook, internal)
  middleware/
    verify-session-token.ts  Checks the token on every protected route
    initialize-store.ts      Store setup + token exchange. Used ONLY by GET /api/store
    error-handler.ts         Turns errors into JSON answers
    rate-limit.ts            Rate limits: /api, /webhooks and /internal (and a helper for new routes)
    verify-staff.ts          Checks the staff login cookie on /internal routes (and requireAdmin)
    internal-guard.ts        /internal checks: the IP list and the Origin check
  controllers/             Code that answers each route
  services/
    shopify-auth.service.ts    ID token check, token exchange, refresh, encrypt and decrypt
    store.service.ts           Redis lock, ensure and refresh tokens, callAdminApi
    password.service.ts        Staff passwords (argon2id hash and check)
    totp.service.ts            2FA: secret, QR picture, code check
    staff-session.service.ts   The staff login cookies
    support-token.service.ts   The support token ("Open as merchant")
    app-installation.service.ts  Asks Shopify if the app is still installed (used by shop/redact)
    order-webhook.service.ts   Handlers for the order webhooks and themes/update (your own logic goes here)
    webhook.service.ts         Save and process webhooks
  repositories/
    store.repository.ts    All SQL queries for shops
    staff.repository.ts    All SQL queries for staff users
  models/store.model.ts    Types for the stores table
  models/staff.model.ts    Types for the staff_users table
  queues/                  BullMQ queue (adds jobs) and worker (does jobs)
  jobs/                    Cron jobs (token keep-alive, stuck webhooks, cleanup)
  scripts/create-admin.ts  Makes the first admin (run once)
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
   |   /api/*      checks the ID token (or a support token)       |
   |   /webhooks   checks the HMAC signature                      |
   |   /internal   checks the staff login cookie (our staff)      |
   +-------+-------------------+--------------------+-------------+
           |                   |                    |
           v                   v                    v
        MySQL                Redis            Shopify Admin API
   (shops, tokens,      (locks, job line)    (called with the saved
    webhook events)                            offline access token)
```

Our own support staff do not come through Shopify. They log in at `/internal` and can then open one shop. See section 15.

---

## 5. Environments and the .env file

We have 4 environments. Two settings choose which one runs:

- `APP_ENV` says **which** environment this is. Our own code uses it.
- `NODE_ENV` says "development" or "production" mode. Express and other libraries use it.

| APP_ENV | NODE_ENV | Staff 2FA code | Error details shown to the caller | Shopify credentials |
|---|---|---|---|---|
| `local` (your laptop) | `development` | required by default. `STAFF_REQUIRE_2FA=false` is allowed here **only** | yes | development app |
| `development` (dev server) | `development` or `production` | **required** | yes | development app |
| `staging` | **must be** `production` | **required** | no | staging app (its own) |
| `production` | **must be** `production` | **required** | no | production app (its own) |

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
| `APP_HOST` | yes | Public host of this backend, **without** `https://`. Only the host name: no port, no path, no placeholder text. The app stops at start with a clear message if it is not |
| `DB_HOST`, `DB_USER`, `DB_NAME` | yes | MySQL connection |
| `DB_PORT` | no (3306) | MySQL port |
| `DB_PASSWORD` | no (empty) on `local` and `development`, **required** on `staging` and `production` | MySQL password. The app does not start on a real server without it |
| `TOKEN_ENCRYPTION_KEY` | yes | 32-byte key (base64). Encrypts tokens in MySQL |
| `TOKEN_ENCRYPTION_KEY_ID` | no (`v1`) | Name of the active key. Change it when you rotate the key |
| `TOKEN_ENCRYPTION_OLD_KEYS` | no | Old keys, only to read old tokens. Format: `v1=base64key,v0=base64key` |
| `STAFF_SESSION_SECRET` | yes | Secret that signs the staff login cookie. 32 bytes in base64. Must be different from every other secret |
| `SUPPORT_TOKEN_SECRET` | yes | Secret that signs the support token. 32 bytes in base64. Must be different from every other secret |
| `STAFF_REQUIRE_2FA` | no (`true`) | `true` = staff must use a 2FA code. `false` is allowed **only** when `APP_ENV=local` |
| `STAFF_SESSION_MINUTES` | no (30) | The staff login, and every support session, ends this many minutes after login (5 to 480) |
| `APP_FRONTEND_URL` | yes | Address of your React app: protocol and host only, no path (for example `http://localhost:5173`). It must be `https` on staging and production. The CORS check and the Origin check for `/internal` use it |
| `STAFF_ALLOWED_IPS` | no (empty) | Comma separated IP addresses that may use `/internal`. Empty = no limit |
| `REDIS_URL` | no (`redis://127.0.0.1:6379`) | Redis address |
| `CORS_ORIGINS` | no (empty) | Websites that may call `/api` from a browser. Comma separated, for example the origin of your React app |

Make a new encryption key (or any 32-byte secret) with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Make `STAFF_SESSION_SECRET` and `SUPPORT_TOKEN_SECRET` with the same command (run it two times). **Every secret must be different** from the others: `STAFF_SESSION_SECRET`, `SUPPORT_TOKEN_SECRET`, `SHOPIFY_CLIENT_SECRET` and every `TOKEN_ENCRYPTION_KEY`. The app refuses to start if two of them are the same. Use **different** values on every environment.

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
   mysql -u root -p delivery_date_app < database/migrations/003_create_staff_users.sql
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
   STAFF_SESSION_SECRET=<make one with the same command>
   SUPPORT_TOKEN_SECRET=<make another one with the same command>
   APP_FRONTEND_URL=http://localhost:5173
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

9. **Make the first admin** (once). The first admin cannot create itself, so a script does it:
   ```bash
   npm run staff:create-admin -- --username admin
   ```
   It prints a random password **one time**. Save it now. The admin sets up 2FA at the first login. Then the admin makes the other staff users (section 15.6).

### npm commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the server and restarts it when you change a file. It does **not** check types |
| `npx tsc --noEmit` | Checks types only. Run it before you commit |
| `npm run build` | Builds to the `dist` folder |
| `npm start` | Runs the built app (`node dist/server.js`) |
| `npm run staff:create-admin -- --username <name>` | Makes the first admin and prints a random password once. On a server that has only the build, use `node dist/scripts/create-admin.js --username <name>` |

### Test without opening Shopify Admin (support session)

There is no standalone token any more. To look at a shop **outside Shopify Admin** (from Postman, or from the React app when it is not embedded), a staff member uses a **support session**:

1. Open the app once in Shopify Admin, so `GET /api/store` runs and the shop exists in MySQL with the status `installed`. A shop that never installed the app cannot be opened.
2. Log in as staff: `POST /internal/staff/login`, then the 2FA code (section 16).
3. Call `POST /internal/support/sessions` with the shop domain. It returns a support token.
4. Use it: `Authorization: Bearer <token>`. The role `support` can only read (GET and HEAD). The role `admin` can also change data. The token ends when the staff login ends (30 minutes).

Full steps and examples are in sections 15 and 16.

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
| `Missing required environment variable: STAFF_SESSION_SECRET` (or `SUPPORT_TOKEN_SECRET`, or `APP_FRONTEND_URL`) | Add it to `.env`. The value must not be empty |
| `STAFF_SESSION_SECRET must be a base64 text that decodes to at least 32 bytes` | Make a new secret with the command in section 5 |
| `... and ... must not have the same value` | Two secrets are equal. Make a new one for each |
| `STAFF_REQUIRE_2FA=false is allowed only when APP_ENV=local` | Remove it, or set it to `true`. 2FA cannot be switched off on a server |
| `APP_FRONTEND_URL must be an origin only ...` or `... must use https on staging` | Use only protocol and host, for example `https://app.example.com` |
| MySQL error `ER_NO_SUCH_TABLE` for `staff_users` | Run migration `003_create_staff_users.sql` (step 3) |

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

A **support token** (section 15) goes through the same `verifySessionToken`. It has its own branch there: it checks the support token, checks the staff user in MySQL, and lets `GET` and `HEAD` pass. For any other method the staff user must have the role `admin`, and the change is written to the log. It never does a token exchange.

### 7.5 Rules for the React app

1. Call **`GET /api/store` first** and **wait** for it to finish. Do not start other API calls at the same time.
2. Send a fresh `Authorization: Bearer <await shopify.idToken()>` on every call.
3. If any other call answers **409** (`Store is not set up yet. Call GET /api/store first.`), call `GET /api/store` once, then try the first call again once.

In a support session (section 15) the app sends `Authorization: Bearer <support token>` instead of an ID token. The role `support` can only read. The role `admin` can also change data.

### 7.6 Errors the frontend can get

| Status | When | What the frontend should do |
|---|---|---|
| **401** with header `X-Shopify-Retry-Invalid-Session-Request: 1` | The ID token is missing a good signature, expired, or Shopify rejected it during the exchange | Get a new ID token and try again. App Bridge does this for you with this header |
| **401** without that header | No token, or a support token that is not good any more (it ended, or the staff user logged out or was disabled) | Fix the request. In a support session, log in as staff again |
| **403** | A support session of the role `support` tried to change something (only an `admin` may) | Show "Only an admin can change data in a support session." Do not send the change |
| **404** | The route does not exist, or the shop is missing | Check the URL, or call `GET /api/store` first |
| **409** | The shop or its token is not set up yet | Call `GET /api/store`, then try again |
| **429** | Too many requests from one IP (rate limit) | Wait the number of seconds in the `Retry-After` header, then try again |
| **502** or **429** | Shopify answered an Admin API call with an error status (for example 403 or 5xx gives 502, and 429 means too many calls) | Show a message and try again later. For 429, wait a bit |
| **503** | Another request is refreshing the token and did not finish in time | Try again in a moment |
| **504** | Shopify did not answer in time (15 seconds for an Admin API call, 10 seconds for the token exchange) | Show "Shopify is slow, try again later". For `GET /api/store`, try it again |
| **500** | Any other error | In `local` and `development` the message is shown. In `staging` and `production` it is always `Internal server error`. See the server log |

### Log lines for errors

Every error that reaches `middleware/error-handler.ts` writes **one** entry in the log:

| Log entry | Level | Meaning |
|---|---|---|
| `[http] 409 PATCH /api/store/onboarding shop=abc.myshopify.com - Store is not set up yet. ...` | warning | An **expected** answer (any 4xx, for example 409, 400 bad JSON, 413 body too big). One short line, **no stack** |
| `[http] 500 GET /api/store shop=abc.myshopify.com` and then the error with its stack | error | A **real problem** (5xx, including 502 and 504 from Shopify). Look at it |

- The log never contains the query string (it can hold private data). This is true for the error lines and for the request log (it shows the path only).
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

# Keep TOKEN_ENCRYPTION_KEY_ID=v1 with your current key the first time you use this code. That way nothing changes for tokens you already have. If your real .env has a different id such as v2 and you already saved tokens, because old tokens would be read with the wrong key id.


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

Details of the refresh that are good to know:

- **Saving the new tokens.** Shopify keeps the refresh token you presented usable until you use the newer one (at most 30 days after its first use, and never past its 90 day end). So if the database fails while we save new tokens, the shop is **not** locked out: the next refresh uses the refresh token we still hold. We still try the save 3 times (after 0.3 and 1 second), so the newest tokens are kept. If all 3 fail, the log says `the new tokens for ... could NOT be saved`. Do not run a token exchange and a refresh for the same shop at the same time (the Redis lock stops this).
- **A refresh answer must be complete.** Shopify sends a new access token **and** a new refresh token on every refresh, each with its end time. If any of the four parts is missing or wrong, the answer is treated as failed and **nothing is saved**, so a half answer can never replace good tokens. The same check applies to the first token exchange: it must return the expiry and the refresh token.
- **Waiting for another request.** If another request is already refreshing, this request waits up to 5 seconds. If the token is still not fresh after that, it tries once itself. If the lock is still taken, it answers 503. It never hands out an expired token.
- **Shopify errors in `callAdminApi`.** Any HTTP error from Shopify (400 or higher, except 401) is now an error: 429 stays 429, everything else becomes 502. A 401 is handled by a refresh, as before.
- **ID token checks.** The token must have `exp` and `nbf`, and its shop name must be `<name>.myshopify.com`.

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
- Shopify does not promise the order of webhooks. A late uninstall webhook that is **older** than the last install is ignored, so it cannot erase new tokens. A refresh is not an install, so it does not move `last_installed_at`. A refresh that finishes after the shop was uninstalled saves nothing. A token exchange that finishes after the shop was uninstalled also saves nothing: `saveOfflineToken` returns `false` when the uninstall is newer than the moment the exchange **started**, and the request fails with a clear message (the merchant opens the app again). For this reason `last_installed_at` holds the time the exchange started, not when it ended.
- About 48 hours after an uninstall, Shopify sends `shop/redact`. If our database says the shop is `uninstalled` or `pending`, we delete it. If the database says `installed` (or `reinstalled`), we **ask Shopify first**, with the tokens we saved: one small API call, and if that gets a 401 we try to refresh the token. If Shopify accepts the token, the app is installed (for example the merchant installed again and uses it), so we **keep** the shop. If Shopify refuses both tokens (or we have no token), the app is gone (the uninstall webhook was lost), so we delete the shop. If we cannot tell (Shopify busy, network problem), we delete nothing and the event is tried again later.

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
- **Only the row id goes in the queue.** Redis keeps job data in plain text. Some payloads hold a person's email and phone, so the real payload stays in MySQL. Before saving, the app cuts it down to the few fields it uses, so a stored event never holds an address, email or phone.
- **Slow work never blocks Shopify.** The worker does the work after we answered.

### 8.3 What each topic does

| Topic (as stored) | What the code does |
|---|---|
| `APP_UNINSTALLED` | Marks the shop `uninstalled` and erases the tokens (ignored if older than the last install) |
| `SHOP_REDACT` | Deletes the shop row (and its webhook rows) when the shop is `uninstalled` or `pending`. When the database says `installed`, it asks Shopify first (see 7.9): keeps the shop if the app is in use, deletes it if Shopify says the app is gone, and tries again later if Shopify cannot be reached |
| `CUSTOMERS_DATA_REQUEST` | Writes a log line (the app stores no customer data today), then wipes the saved payload |
| `CUSTOMERS_REDACT` | Clears the stored delivery data of the listed orders (events that are still waiting or failed still hold it), writes a log line, then wipes the saved payload |
| `ORDERS_CREATE`, `ORDERS_UPDATED`, `ORDERS_FULFILLED`, `ORDERS_CANCELLED` | Writes one log line (order number and id only), then **wipes the saved payload**, because an order can hold personal data. Your own logic goes in `services/order-webhook.service.ts` (see 8.6) |
| `THEMES_UPDATE` | Writes one log line (theme name, id and role). A theme has no customer data, so the payload is kept |
| `SHOP_UPDATE` | Reads the shop details again from Shopify and saves them (see 7.10). Skipped quietly if the shop has no token |
| any other topic | Nothing to do. Marked `completed` |

The library writes topics in capital letters with underscores: `app/uninstalled` becomes `APP_UNINSTALLED`.

> **Do this when the date picker starts storing customer data** (for example a delivery date linked to an order or customer): make `CUSTOMERS_DATA_REQUEST` and `CUSTOMERS_REDACT` really export and delete that data. Today they only log.

### 8.4 When things go wrong

| Problem | What happens |
|---|---|
| Redis is down when a webhook arrives | We already said 200. The row stays `received`. The **sweeper** (every 2 minutes) finds rows older than 5 minutes and queues them again |
| The worker fails | BullMQ tries 5 times in total (2s, 4s, 8s, 16s between tries). The row shows `failed` with the error text |
| All 5 tries failed | The log says `[webhook-worker] GAVE UP on event N`. The sweeper then tries the event again: once every 10 minutes, at most 6 times, only while the event is less than 6 hours old (the counters are in Redis). After that the log says `[requeue-failed-webhooks] GAVE UP ... for good`, and the row stays `failed` for you to look at (SQL below) |
| `shop/redact` and Shopify cannot be reached | The shop is **not** deleted, the event is not marked `completed`, and the queue tries again (then the sweeper, for about an hour). If it still fails, the log says `GAVE UP`, and you must look at it (the redact must be done within the time Shopify requires) |
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

### 8.6 Order and theme webhooks

Topics we handle: `orders/create`, `orders/updated`, `orders/fulfilled`, `orders/cancelled`, `themes/update`.
Careful with the names: it is `orders/updated` and `orders/cancelled` (with "d"), but `orders/create` (without).

**What the code does today:** it saves the event, answers 200, and the worker handles it. For orders it writes one log line, for example `[orders] created: shop=abc.myshopify.com #1001 (id 1234567890123)`, and then wipes the saved payload. For a theme it writes one log line. Nothing else is saved yet. The functions `onOrderCreated`, `onOrderUpdated`, `onOrderFulfilled`, `onOrderCancelled` and `handleThemeUpdateWebhook` in `src/services/order-webhook.service.ts` are the places for your own logic. They get a small, safe summary of the order (`id`, `name`, dates, statuses and the note attributes as `{ name: value }`). A delivery date picked on the cart page is usually in `attributes`.

**Shopify app configuration** (`shopify.app.toml`). Add the scopes to your existing list, add the two blocks, then run `shopify app deploy`:

```toml
[access_scopes]
scopes = "<your current scopes>,read_orders,read_themes"

[[webhooks.subscriptions]]
topics = [ "orders/create", "orders/updated", "orders/fulfilled", "orders/cancelled" ]
uri = "/webhooks"
include_fields = [ "id", "admin_graphql_api_id", "name", "created_at", "updated_at", "cancelled_at", "cancel_reason", "fulfillment_status", "financial_status", "note_attributes", "line_items" ]

[[webhooks.subscriptions]]
topics = [ "themes/update" ]
uri = "/webhooks"
```

Notes:

- **`include_fields` keeps customer data out.** Without it, Shopify sends the whole order (name, email, phone, address). With it, we only get the fields we need, and the payload stays small. Remove `line_items` if your picker saves the date only in the cart attributes (`note_attributes`).
- **Merchants must approve new scopes.** Shops that already installed the app see a request in their admin.
- **Protected customer data.** Forum and third-party posts say order webhooks can fail, or arrive with empty customer fields, if the app has no approval for protected customer data. Check in the Partner Dashboard (your app, API access, Protected customer data access). We could not confirm the exact rule on Shopify's own pages.
- **If you start saving order data linked to a customer**, `customers/data_request` and `customers/redact` must really export and delete that data. Today they only write a log line. Shopify sends these two to apps that have access to customer or order data.
- **`orders/updated` is very frequent**, and Shopify does not promise the order of webhooks. Each event is one MySQL row and one queue job (cleaned after 30 days). When you save order data, compare `updatedAt` and ignore an event that is older than what you have.
- **Partial fulfillment.** `orders/fulfilled` is for fulfilled orders. If you also need partly fulfilled orders, check Shopify's topic list for a separate topic.
- **Body size.** `POST /webhooks` accepts up to **5 MB** (`WEBHOOK_BODY_LIMIT` in `routes/webhook.routes.ts`). A refused body counts as a failed request in the webhook rate limit, so keep this limit above your biggest order.
- **`themes/publish`.** `themes/update` fires when a theme changes. To know when the merchant switches to another main theme (and the date picker block must be added again), also subscribe to `themes/publish` and add a case for `THEMES_PUBLISH`.
- **Failed events keep a small payload.** If a handler fails all its tries, the payload stays in MySQL (up to 90 days), because the retries need it. Before saving, the app cuts the payload down to the fields it uses (for orders: ids, names, dates, statuses and a delivery date), so no address, email or phone is kept. `include_fields` still helps to keep the webhook small.
- **Delivery date attribute.** When an order event is saved, only one note attribute is kept: its name must contain "delivery" and "date" (in any order, any case) and its value must look like `YYYY-MM-DD`. It is stored under the name `Delivery Date`. If your date picker uses another name or format, change `pickDeliveryDateAttribute` in `services/webhook.service.ts`.


---

## 9. Background jobs

All jobs start in `server.ts`. The times use the **server's time zone**.

| Job | When | What it does |
|---|---|---|
| `refresh-stale-tokens` | every day 03:00 | First marks, once, every shop whose refresh token has already ended (`last_token_exchange_status = failed`, "the merchant must open the app again"). Then refreshes the token of shops whose refresh token ends within the next 14 days (not the ones that already ended). Waits 250 ms between shops |
| `requeue-stuck-webhooks` | every 2 minutes | Queues again the events that stayed `received` for more than 5 minutes. Also queues again `failed` events (every 10 minutes, at most 6 times, only if less than 6 hours old) |
| `cleanup-webhook-events` | every day 04:00 | Deletes `completed` events older than 30 days. Deletes `failed`, `received` and `processing` events older than 90 days (and warns about the last two) |

The webhook worker (5 jobs at the same time) runs inside the same process as the web server.

### Shutdown (Ctrl+C, SIGTERM)

When the server gets `SIGINT` or `SIGTERM`, it stops in this order:

1. It stops the 3 cron jobs: no new run starts, and a run that is busy right now is finished first (`waitForCompletion`).
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
| Old local testing | `standalone_token_version` is **not used any more** (it belonged to the old standalone token). You can drop the column later |
| App settings | `storefront_enabled`, `settings_json` |
| Plan and billing | `app_plan`, `app_plan_status`, `billing_status`, `shopify_subscription_id` and more |

### `webhook_events` (one row per webhook)

| Column | Meaning |
|---|---|
| `shopify_webhook_id` | Unique. Stops the same webhook being saved twice |
| `topic`, `shop_domain`, `payload` | What Shopify sent. The payload is cut down to the fields the app uses before it is saved, and it is wiped after the event is handled |
| `triggered_at` | When Shopify says it happened |
| `status` | `received` (saved), `completed`, `failed`. (`processing` exists in the table but the code does not use it yet) |
| `error` | Error text when it failed |

It has an index on `(status, received_at)` that makes the sweeper and the cleanup job fast. When a shop is deleted, its webhook rows go with it.

### `staff_users` (one row per staff member)

Migration `003_create_staff_users.sql`. This is the **only** table for staff login and support. There is no audit table: events go to the server log (section 15.7).

| Group | Columns |
|---|---|
| Identity and access | `staff_id`, `username` (unique, lowercase), `password_hash` (argon2id), `role` (`support` or `admin`), `status` (`active` or `disabled`) |
| Stopping sessions | `session_version`. Raise it and every staff session and support token of that user stops at once |
| 2FA | `totp_secret_encrypted` (encrypted with `TOKEN_ENCRYPTION_KEY`), `totp_enabled`, `totp_last_used_step` (a 2FA code from the same time step or an older one is refused) |
| Login protection | `failed_login_count`, `locked_until` |
| Database | `created_at` |

### Time

All times are saved in **UTC**. The MySQL pool uses `timezone: 'Z'` and sets `time_zone = '+00:00'` for every connection. The app stops at start if the session is not UTC.

---

## 11. All routes

| Route | Who calls it | How it is checked | Notes |
|---|---|---|---|
| `GET /health` | anyone | nothing | "The process is running." Returns `{"status":"ok"}`. It never checks MySQL or Redis, on purpose. Use it to decide if the app must be restarted |
| `GET /ready` | anyone | nothing | "The app can do its work." Checks MySQL and the three Redis connections (locks, queue, webhook worker), 2 seconds at most for each. Answers 200 `ready`, or 503 `not_ready` with `mysql` and `redis` each `ok` or `down`. The answer is kept for 3 seconds. Use it for a load balancer |
| `POST /webhooks` | Shopify | HMAC signature | Raw body. See section 8 |
| `GET /api/store` | React app (or a support session) | ID token, then `initializeStore` (or a support token) | **First API.** Creates the shop, does the token exchange, and reads the shop details (7.10). Returns store info. With a support token it only reads the shop from MySQL (no exchange) |
| `PATCH /api/store/onboarding` | React app | ID token | Marks onboarding done. Answers 409 if the shop row does not exist yet |
| `GET /api/store/me/admin-api-example` | React app | ID token | Example of a safe Admin API call with `callAdminApi`. It exists **only** in `local` and `development` (it returns a raw Shopify answer) |
| `POST /internal/staff/login` | Our staff (React app, outside Shopify Admin) | nothing (rate limited) | Username and password. Answers `setup`, `verify` or `done` (section 15.4) |
| `POST /internal/staff/2fa/setup`, `/2fa/confirm`, `/2fa/verify` | Our staff | the "password was right" cookie | The 2FA steps |
| `POST /internal/staff/logout` | Our staff | staff cookie (optional) | Ends **all** sessions and support tokens of that user |
| `GET /internal/staff/users`, `POST /internal/staff/users`, `PATCH /internal/staff/users/:id` | Admin staff | staff cookie + role `admin` | List, create, disable or enable, new password, 2FA reset |
| `POST /internal/support/sessions` | Our staff (any role) | staff cookie | "Open as merchant". Returns a support token for ONE shop |

Every `/internal` `POST` and `PATCH` must have the header `Origin: <APP_FRONTEND_URL>` (a browser sends it by itself; Postman does not).

### Add a new route the safe way

- Put it **below** `router.use(verifySessionToken)` in the routes file. Then the token is always checked first.
- **Only** `GET /api/store` should use `initializeStore`. If another route must be allowed to be the first call for a shop (for example for a POS extension), add `initializeStore` to that route, but only **after** `verifySessionToken`:
  ```ts
  router.use(verifySessionToken);
  router.get('/', initializeStore, getCurrentShop);
  router.get('/pos/summary', initializeStore, posSummary); // example: also allowed to set up a shop
  ```
  If `initializeStore` runs **before** `verifySessionToken`, the route has no login check at all.
- The role `support` can only call `GET` and `HEAD` with a support token. `verifySessionToken` blocks everything else with 403, so a new route that changes data is safe without extra work. An `admin` can call every method, and each change is written to the log. This means a `GET` route must **never** change data.
- When a controller needs the Shopify Admin API, always call it through `callAdminApi`, and add `signal: AbortSignal.timeout(...)` to the `fetch`.

### Rate limits

| Where | Limit | What counts |
|---|---|---|
| Everything under `/api` (React admin app) | 300 requests per minute per IP | every request |
| `POST /webhooks` | 50 per 10 minutes per IP | **only failed requests** (bad signature, bad body, too big). Good Shopify webhooks are never counted |
| Everything under `/internal` (staff) | 120 requests per minute per IP | every request |
| Staff login steps (`/staff/login`, `/2fa/verify`, `/2fa/confirm`) | 50 per 15 minutes per IP | every request. Each account is also locked for 15 minutes after 5 wrong tries |
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
- The ID token must have `exp` and `nbf`, and its shop must be `<name>.myshopify.com`.
- Rate limits are on `/api` and `/webhooks`. `TRUST_PROXY` must match the real number of proxies in front of the server.
- Tokens are encrypted in MySQL (AES-256-GCM). The key is only in the environment.
- Staff passwords are saved as argon2id hashes. Staff 2FA (TOTP) is required everywhere except on `local`. The 2FA secret is encrypted in MySQL, and a 2FA code works only once.
- The staff login cookie is `httpOnly`, `SameSite=Strict`, `Secure` (except on `local`), and it ends 30 minutes after login. Every request that changes something on `/internal` must have the right `Origin` header.
- A wrong password or 2FA code 5 times locks the account for 15 minutes. Every login problem gets the same answer, so nobody can find out which usernames exist.
- A support token is for ONE shop, ends with the staff login, and is checked against the staff row on every request. The role `support` can only read (GET and HEAD). The role `admin` can also change data, and every change is written to the log (there is no audit table). Logout, disabling, a new password and a 2FA reset stop the token at once.
- The staff cookie secret, the support token secret, the Shopify secret and the encryption keys must all be different. The app refuses to start if two are the same.
- In `staging` and `production`, errors never show their message to the caller.
- Security headers (helmet) are on. Only Shopify Admin may put the app in an iframe (`frame-ancestors`).
- Webhook payloads with personal data (customer privacy topics and orders) are wiped after they are handled, and job data in Redis holds only a row id.
- `.env` files are ignored by git. **Do not commit them, and do not put them in zip files you share.**
- Use **different** keys, secrets and Shopify credentials for staging and production.

---

## 14. Good to know and things to do later

### Good to know

- Only `.env` is read. `.env.local`, `.env.development`, `.env.staging` and `.env.production` are notes, not auto-loaded files (section 5).
- There are two ways to save tokens. A **refresh** uses `saveRefreshedTokens`: it changes only the tokens and the token health columns. It never changes `installation_status`, `last_installed_at` or `last_seen_at`, and it never saves tokens for an uninstalled shop. A **new token exchange** (first install, reinstall, or the fallback when the refresh token is dead) uses `saveOfflineToken`, which counts as an install and moves `last_installed_at`. If the shop was uninstalled after the exchange started, `saveOfflineToken` saves nothing and returns `false`.
- The webhook sweeper only picks up `received` rows. A webhook that failed all 5 tries stays `failed` until you look at it.
- The server keeps idle connections open for 65 seconds (`keepAliveTimeout`), longer than the usual 60 second timeout of a load balancer. Node's own default is 5 seconds, which can cause random 502 errors behind a load balancer.
- `GET /health` only says the process is running (on purpose, so a short MySQL or Redis problem does not restart a healthy server). Use `GET /ready` to check MySQL and Redis.
- The worker and the cron jobs run inside the web server process. If you run several copies of the server, every copy runs the cron jobs. This is safe today (locks and unique job ids stop double work), but it is wasted work.

- Staff login and support (section 17) lives in the same server process as everything else. The staff cookie works only when the React app and the backend are on the **same site** (for example `app.example.com` and `api.example.com`).

### To do later

Found by the audit of 15 October 2026 and **not done on purpose** (they are not bugs today):

- **Several server copies.** The cron jobs, the worker and the rate limit counters run inside every copy. With 2 or more copies the jobs run twice. Before you scale out, run the cron jobs through BullMQ repeatable jobs (or a Redis lock) and use a Redis store for the rate limit.
- **Two exchanges at nearly the same time.** After a 10 second timeout, a late answer from Shopify can retire the token of a second exchange. This needs Shopify to be more than 10 seconds late.
- **Rate limit per shop** (today it is per IP, and merchants can share an IP).
- **Better logging** (pino with redaction and request ids) and an error tracker.
- **Database TLS** (needs the settings of your database host).

- **Staff:** a "change my own password" option (today only an admin can set a new password), backup codes for a lost phone (today an admin resets the 2FA), and an audit table (today there are only `[staff]` and `[support]` log lines).
- Drop the unused column `standalone_token_version` from `stores`.
- A migration tool (today the SQL files are run by hand).
- Automated tests (a test with a real MySQL would catch SQL mistakes that TypeScript cannot see).
- `verifyAppProxy` and the `/proxy` and `/ext` routes (section 12).
- A Docker Compose file for MySQL and Redis, to make local setup easier.
- Real deletion code for `CUSTOMERS_DATA_REQUEST` and `CUSTOMERS_REDACT` once customer data is stored.
- Check the shop query (section 7.10) in Shopify's GraphiQL with your API version once. Shopify's docs for newer versions list `plan.publicDisplayName` instead of `plan.shopifyPlus`.
- A `typecheck` script, and replace `ts-node-dev` with `tsx` (it brings 3 high-severity warnings in `npm audit`, in dev tools only).


---

## 15. Staff login and support access ("Open as merchant")

### 15.1 What it is, in simple words

Sometimes our own staff must see what a merchant sees, or fix something for them. The staff member logs in to our React app (outside Shopify Admin), types a shop domain, and sees that shop's app. A staff member with the role `support` can only **look**. A staff member with the role `admin` can also **change** things.

In short:

- Staff are **not** merchants. They log in with a **username and password**, and a **2FA code**.
- Only an **admin** creates staff. The admin chooses the username and the first password and gives them to the staff member. There is no sign-up and no invite link.
- The staff login lasts **30 minutes**, counted from the login. It never gets longer.
- A staff member with the role `support` can only **read** in a support session (every change is refused with 403). A staff member with the role `admin` can also **change data**.
- A support session ends at the same moment as the staff login. Logout, disabling the user, a new password or a 2FA reset stop it at once.
- Every change an admin makes in a support session is written to the server log (who, which shop, which route, the result). There is no audit table.

### 15.2 Diagram

```text
 Staff member (React app, outside Shopify Admin)
        |
        | 1. POST /internal/staff/login        (username + password)
        | 2. POST /internal/staff/2fa/verify   (6-digit code)
        v
 +-----------------------------------+
 |  Backend  /internal               |   gives the cookie "staff_session"
 |  checks cookie + staff row        |   (httpOnly, 30 minutes)
 +-----------------------------------+
        |
        | 3. POST /internal/support/sessions   { "shopDomain": "my-store" }
        v
   support token for ONE shop  (ends when the staff login ends)
        |
        | 4. GET /api/store     Authorization: Bearer <support token>
        v
 +-----------------------------------+
 |  Backend  /api                    |   GET and HEAD: every staff user.
 |  verifySessionToken               |   Other methods: only the role admin (else 403)
 +-----------------------------------+
```

### 15.3 One-time setup

1. Put the six new settings in `.env` (section 5): `STAFF_SESSION_SECRET`, `SUPPORT_TOKEN_SECRET`, `STAFF_REQUIRE_2FA`, `STAFF_SESSION_MINUTES`, `APP_FRONTEND_URL`, `STAFF_ALLOWED_IPS`.
2. Run the migration `database/migrations/003_create_staff_users.sql` (section 6, step 3).
3. Make the first admin: `npm run staff:create-admin -- --username admin`. Save the password it prints. It is shown only once.
4. Log in with that admin (section 16). At the first login the admin sets up 2FA with an authenticator app.
5. The admin creates the other staff users (section 15.6).

### 15.4 How the staff login works

| Step | Route | What happens | Answer |
|---|---|---|---|
| 1 | `POST /internal/staff/login` `{ username, password }` | The password is checked. Unknown user, wrong password, disabled and locked all give the **same** answer | `{ "next": "setup" }` (2FA not set up yet), `{ "next": "verify" }` (ask for the code), or `{ "next": "done", ... }` (only on `local` with `STAFF_REQUIRE_2FA=false`) |
| 2a | `POST /internal/staff/2fa/setup` | Only the first time. Makes a new secret | `{ "qrCodeDataUrl": "data:image/png;base64,...", "secret": "..." }` |
| 2b | `POST /internal/staff/2fa/confirm` `{ code }` | The first code from the app. If right, 2FA is turned on and the user is logged in | `{ "next": "done", "username", "role", "expiresAt" }` |
| 2c | `POST /internal/staff/2fa/verify` `{ code }` | Every later login. A code works only **once** | `{ "next": "done", "username", "role", "expiresAt" }` |
| - | `POST /internal/staff/logout` | Ends **all** sessions and support tokens of this user | `{ "success": true }` |

How the codes are checked: the app and the server work out the same 6-digit code from a shared secret and the clock. The server accepts the current 30-second window and one before and one after (clocks are never exactly the same). The number of the window that was used is saved, so the same code cannot be used twice.

Locks: 5 wrong tries (passwords **and** 2FA codes together) lock the account for 15 minutes. The count is cleared only after a full login, and a new password also clears a lock.

### 15.5 The two cookies

| Cookie | Path | Lives | What it means |
|---|---|---|---|
| `staff_pending` | `/internal/staff` | 5 minutes | "The password was right. Now the 2FA code is needed." |
| `staff_session` | `/internal` | `STAFF_SESSION_MINUTES` (30) from the login. Fixed | The real login |

Both are `httpOnly` (the page's JavaScript cannot read them), `SameSite=Strict` (the browser does not send them from another site), and `Secure` on every environment except `local`. Both hold a signed token. The `session_version` is inside, so a cookie of an old session is dead after a logout.

### 15.6 Managing staff (admin only)

| Route | Body | What it does |
|---|---|---|
| `GET /internal/staff/users` | - | The list. It never shows a password hash or a 2FA secret |
| `POST /internal/staff/users` | `{ "username", "password", "role" }` | Makes a staff user. The password needs at least 12 characters. Role is `support` or `admin`. Answer: 201 |
| `PATCH /internal/staff/users/:id` | **exactly one** of `{ "status": "disabled" }`, `{ "status": "active" }`, `{ "password": "..." }`, `{ "resetTwoFactor": true }` | Disable or enable, set a new password (also clears a lock), or remove 2FA (the user sets it up again at the next login) |

Rules:

- Every change on a user also raises their `session_version`, so their sessions and support tokens stop at once.
- An admin cannot disable **their own** account.
- The **last active admin** can never be disabled. This holds even when two admins disable each other at the same moment (a database transaction locks the admin rows).
- The admin knows the first password. Send it through a safe channel.
- If an admin changes **their own** password or resets **their own** 2FA, they are logged out at once.

### 15.7 The support session ("Open as merchant")

`POST /internal/support/sessions` with `{ "shopDomain": "my-store" }`. Any logged-in staff member (role `support` or `admin`) may call it.

1. The domain is cleaned. `my-store`, `My-Store.myshopify.com` and `https://my-store.myshopify.com/admin` mean the same shop.
2. The shop must exist in MySQL with the status `installed` or `reinstalled`. If not: 404 `Store not found, or the app is not installed on it`.
3. If the staff login has less than 30 seconds left: 401 (the page would log out at once).
4. A line goes to the server log: `[support] staff=rahul shop=my-store.myshopify.com ip=...`.
5. The answer: `{ "shopDomain", "token", "expiresAt", "canEdit" }`. The token ends at the **same moment** as the staff login. `canEdit` is `true` for the role `admin` and `false` for the role `support`. The React app uses it to show or hide the buttons that change data.

Using the token: `Authorization: Bearer <token>` on `/api` routes. On every request `verifySessionToken` does this:

1. Checks the signature, the end time and the audience (`support`). The token is signed with `SUPPORT_TOKEN_SECRET`, so it can never pass as a Shopify ID token, and a Shopify token can never pass as a support token.
2. Loads the staff row from MySQL. The user must be `active`, the `session_version` must match, and (when 2FA is required) 2FA must be on.
3. Checks that the shop exists.
4. `GET` and `HEAD` pass. For any other method the staff user must have the role `admin`. Otherwise the answer is 403 `Only an admin can change data in a support session.` The role is read from the staff row (not from the token), so it cannot be faked. A change made by an admin is written to the server log: `[support] write staff=... shop=... METHOD /route -> status ip=...` (never the body and never the query string).
5. The shop comes from the **token**. A `?shop=` in the address changes nothing.

What stops a support session:

| What happens | Result |
|---|---|
| The staff login ends (30 minutes) | The token ends too. Next call: 401 |
| The staff member logs out (any tab) | All that user's tokens stop at once |
| An admin disables the user | Stops at once. Enabling again does **not** bring the old token back |
| An admin sets a new password or resets 2FA | Stops at once |
| The tab is closed | The React app keeps the token only in `sessionStorage`, so it is gone |

### 15.8 Protections on `/internal`

| Protection | What it does |
|---|---|
| IP list (`STAFF_ALLOWED_IPS`) | If it is set, only those IPs may use `/internal`. Others get 403 `Not allowed from this address` |
| CORS | Only `APP_FRONTEND_URL` may call it from a browser, with cookies. The CORS for `/internal` is set **before** the normal CORS of `/api` (that one does not allow cookies) |
| Rate limits | 120 per minute per IP for everything, and 50 per 15 minutes per IP for the login steps |
| Origin check | A `POST` or `PATCH` must have `Origin: <APP_FRONTEND_URL>`. Otherwise 403 `Request not allowed` |
| Body size | At most 10 kB of JSON |

### 15.9 Code map

| File | Job |
|---|---|
| `database/migrations/003_create_staff_users.sql` | The `staff_users` table |
| `models/staff.model.ts` | Types, the username rule |
| `repositories/staff.repository.ts` | All SQL for staff: lock counter, `session_version`, 2FA step claim (one atomic query), disabling with the last-admin protection |
| `services/password.service.ts` | argon2id hash and check. For an unknown user it still checks a dummy hash, so the answer takes the same time |
| `services/totp.service.ts` | 2FA secret (encrypted), QR picture, code check |
| `services/staff-session.service.ts` | The two cookies |
| `services/support-token.service.ts` | The support token |
| `middleware/verify-staff.ts` | Reads the cookie and checks the staff row. `requireAdmin` |
| `middleware/internal-guard.ts` | The IP list and the Origin check |
| `middleware/verify-session-token.ts` | The `support` branch, the admin-only write rule and the write log line |
| `controllers/staff-auth.controller.ts` | login, 2FA, logout |
| `controllers/staff-admin.controller.ts` | list, create, update |
| `controllers/support.controller.ts` | "Open as merchant" |
| `routes/internal.routes.ts` | The `/internal` routes |
| `scripts/create-admin.ts` | The first admin |

### 15.10 Errors you can get

| Status | Message | When |
|---|---|---|
| 400 | `Username and password are required` | Missing or too long |
| 401 | `Wrong username or password, or the account is locked.` | Any login problem (same text for all) |
| 401 | `This login step ended. Please log in again.` | The `staff_pending` cookie is missing or older than 5 minutes |
| 401 | `Wrong code` / `This code was already used. Wait for the next code.` | 2FA step |
| 401 | `Please log in again` | No staff cookie, it ended, or the user was logged out, disabled, reset |
| 403 | `Only an admin can do this` | A `support` user called an admin route |
| 403 | `Request not allowed` | The `Origin` header is missing or wrong |
| 403 | `Not allowed from this address` | The IP list is set and this IP is not in it |
| 409 | `Two-step login is already set up` / `...is not set up yet` / `Start the setup first` | 2FA step in the wrong order |
| 409 | `This username is already taken` / `At least one active admin must stay` | Staff management |
| 429 | `Too many wrong tries. Please try again later.` | The account is locked |
| 429 | `Too many requests. Please try again later.` | The IP rate limit |
| 400 / 404 | `Enter the shop domain, for example my-store.myshopify.com` / `Store not found, or the app is not installed on it` | Opening a shop |
| 401 | `Support session ended. Please log in again.` | A support token that ended or was stopped |
| 403 | `Only an admin can change data in a support session.` | A staff user with the role `support` used a support token for anything but GET or HEAD |

---

## 16. Postman examples (staff login and support)

### 16.1 Set up Postman once

- Make a variable `base` with the value `http://localhost:3000`. Use `{{base}}` in the URLs.
- On **every POST and PATCH** add these headers:

  | Header | Value |
  |---|---|
  | `Content-Type` | `application/json` |
  | `Origin` | the value of `APP_FRONTEND_URL`, for example `http://localhost:5173` |

  Postman does **not** send `Origin` by itself. Without it you get 403 `Request not allowed`.
- Postman keeps cookies by itself. The staff cookies are only sent to `/internal/...`. The support token is **not** a cookie: you add it as a header (section 16.5).
- Your staff login ends 30 minutes after you log in. If you get 401 `Please log in again`, log in again.

### 16.2 Phase 1: make the first admin

In the terminal (not Postman):

```bash
npm run staff:create-admin -- --username admin
```

```text
Admin created (local).
  Username: admin
  Password: k7Hq...(20 characters)

Save this password now. It is shown only once.
The admin sets up 2FA at the first login.
```

If the name already exists you get `The username "admin" already exists.` A name must have 3 to 50 characters: lowercase letters, numbers, dot, dash or underscore.

### 16.3 Phase 2: log in (with 2FA)

**First login (2FA setup)**

1. `POST {{base}}/internal/staff/login`
   ```json
   { "username": "admin", "password": "the-password-from-the-script" }
   ```
   Answer: `{ "next": "setup" }`. A `staff_pending` cookie is saved (5 minutes).

2. `POST {{base}}/internal/staff/2fa/setup` (no body)
   ```json
   { "qrCodeDataUrl": "data:image/png;base64,iVBORw0...", "secret": "2K3T5JY3AKXYUA3COKMT5F53NMNYT4ZB" }
   ```
   In Google Authenticator choose **Enter a setup key**, and type the `secret` (time based). Or paste the whole `qrCodeDataUrl` text in your browser's address bar to see the QR picture, and scan it. Calling setup again makes a **new** secret, so the app must hold the newest one. Do not share the secret.

3. `POST {{base}}/internal/staff/2fa/confirm`
   ```json
   { "code": "123456" }
   ```
   Answer, and the `staff_session` cookie is saved:
   ```json
   { "next": "done", "username": "admin", "role": "admin", "expiresAt": "2026-11-24T10:30:00.000Z" }
   ```

**Every later login**

1. `POST {{base}}/internal/staff/login` gives `{ "next": "verify" }`.
2. `POST {{base}}/internal/staff/2fa/verify` with `{ "code": "654321" }` gives the same `done` answer as above.

**Log out**

`POST {{base}}/internal/staff/logout` (no body) gives `{ "success": true }`. All sessions and support tokens of this user stop.

**Answers you may see**

| You sent | Answer |
|---|---|
| A wrong password, or an unknown user | 401 `Wrong username or password, or the account is locked.` |
| The same 2FA code twice | 401 `This code was already used. Wait for the next code.` |
| A wrong code | 401 `Wrong code` |
| 5 wrong tries | The account is locked for 15 minutes. Even the right password gives the same 401 as above |
| A POST without the `Origin` header | 403 `Request not allowed` |

To unlock yourself while testing, run in MySQL: `UPDATE staff_users SET locked_until = NULL, failed_login_count = 0;`

### 16.4 Phase 3: manage staff (log in as an admin first)

1. **List.** `GET {{base}}/internal/staff/users`
   ```json
   { "users": [ { "staffId": 1, "username": "admin", "role": "admin", "status": "active",
                  "totpEnabled": true, "isLocked": false, "createdAt": "2026-11-24T09:00:00.000Z" } ] }
   ```

2. **Create.** `POST {{base}}/internal/staff/users`
   ```json
   { "username": "rahul", "password": "a-long-password-123", "role": "support" }
   ```
   Answer 201: `{ "user": { "staffId": 2, "username": "rahul", "role": "support", "status": "active", "totpEnabled": false, ... } }`. Give the username and password to Rahul. At his first login he sets up 2FA.

3. **Change.** `PATCH {{base}}/internal/staff/users/2`. Send **one** of these per request:
   ```json
   { "status": "disabled" }
   ```
   ```json
   { "status": "active" }
   ```
   ```json
   { "password": "another-long-password-1" }
   ```
   ```json
   { "resetTwoFactor": true }
   ```
   Answer: `{ "user": { ... } }` with the new state.

| You sent | Answer |
|---|---|
| A password under 12 characters | 400 `Password must be at least 12 characters` |
| A bad username | 400 `Username must be 3 to 50 characters: ...` |
| A role other than `support` or `admin` | 400 `Role must be "support" or "admin"` |
| A name that exists | 409 `This username is already taken` |
| Two actions in one PATCH, or none | 400 `Send exactly one of: status, password, resetTwoFactor` |
| An id that does not exist | 404 `Staff user not found` |
| `{ "status": "disabled" }` on **your own** id | 400 `You cannot disable your own account` |
| Disabling the last active admin | 409 `At least one active admin must stay` |
| A `support` user calling these routes | 403 `Only an admin can do this` |

### 16.5 Phase 4: open a shop (support session)

Before you start: the shop must have the app installed (open the app once in Shopify Admin), and you must be logged in as staff. A `support` user may do this too.

1. **Open the shop.** `POST {{base}}/internal/support/sessions`
   ```json
   { "shopDomain": "your-dev-store.myshopify.com" }
   ```
   You can also type only `your-dev-store`. Answer:
   ```json
   { "shopDomain": "your-dev-store.myshopify.com", "token": "eyJhbGciOi...", "expiresAt": "2026-11-24T10:30:00.000Z", "canEdit": true }
   ```
   `expiresAt` is the same moment as the end of your staff login. `canEdit` is `true` when you are logged in as an `admin`, and `false` for a `support` user.

   Tip: in the **Tests** tab of this request add one line, and Postman saves the token for you:
   ```js
   pm.collectionVariables.set("supportToken", pm.response.json().token);
   ```

2. **Read the shop.** `GET {{base}}/api/store` with the header `Authorization: Bearer {{supportToken}}` (no `Origin` and no cookie needed):
   ```json
   { "shopDomain": "your-dev-store.myshopify.com", "shopName": "My Store", "installationStatus": "installed",
     "onboardingCompleted": false, "appPlan": "free", "billingStatus": "free" }
   ```

3. **Try to change something.** `PATCH {{base}}/api/store/onboarding` with the same header. A token opened by a `support` user gets 403 `Only an admin can change data in a support session.` and nothing changes. A token opened by an `admin` gets 200 `{ "success": true }` and the data changes. The server log gets one line: `[support] write staff=admin shop=your-dev-store.myshopify.com PATCH /api/store/onboarding -> 200 ip=...`

4. **Stop it.** `POST {{base}}/internal/staff/logout`, then repeat step 2. Now you get 401 `Support session ended. Please log in again.`

| You sent | Answer |
|---|---|
| `{ "shopDomain": "not a shop!!" }` | 400 `Enter the shop domain, for example my-store.myshopify.com` |
| A shop that does not exist, was uninstalled, or is `pending` | 404 `Store not found, or the app is not installed on it` |
| A call 30 minutes after login | 401 `Support session ended. Please log in again.` |
| `POST`, `PUT`, `PATCH` or `DELETE` with a token opened by a `support` user | 403 `Only an admin can change data in a support session.` |
| The same call with a token opened by an `admin` | The normal answer of that route. The change is written to the log |
| The old route `GET /api/auth/standalone-token` | 404 (it does not exist any more) |

### 16.6 A full check, from start to end

1. Make the first admin. Log in. Set up 2FA. Log out. Log in again with a code.
2. As admin, create `rahul` (role `support`). Log in as `rahul` (in a second Postman cookie jar or after a logout), set up 2FA.
3. Open a shop. Read `GET /api/store`. See the 403 on `PATCH`.
4. Log out. See the 401 on the old token.
5. As admin, disable `rahul`. See that his login now fails. Enable him again.
6. Try to disable your own account. See the 400.

---

## 17. Things to know (staff login and support)

### Phase 1: setup

- The first admin password is shown **once**. If you lose it, make another admin with the script (a new username), or set a new password for the old one in MySQL by hand with an argon2id hash, or ask another admin to set one.
- The script is in `src/scripts/` on purpose. The build only compiles `src`, so on a server that has only the build you can run `node dist/scripts/create-admin.js --username <name>`.
- All secrets must be different from each other, on every environment. The app refuses to start if two are the same. Also use different values on `development`, `staging` and `production`.
- `STAFF_REQUIRE_2FA=false` works only when `APP_ENV=local`. On every other environment the app refuses to start.
- `APP_FRONTEND_URL` is an origin only (no path). It must be `https` on staging and production.
- Only `.env` is read by the app. The other `.env.*` files are notes.
- `argon2` is a native package. If `npm install` fails on a machine, the machine needs build tools.

### Phase 2: staff login

- Postman does not send the `Origin` header. Add it by hand on every POST and PATCH, or you get 403.
- The "password was right" step lasts **5 minutes**. If it ends, log in again. Each call of `2fa/setup` makes a **new** secret, so use the newest one.
- The staff login lasts **30 minutes from the login**, fixed (not "30 minutes without activity"). After that the user must log in again.
- 5 wrong tries lock an account for 15 minutes, and password tries and code tries are counted together.
- A 2FA code works **once**. If you test fast and the code was used, wait for the next one (up to 30 seconds).
- The server clock must be right. Codes are accepted for the current 30-second window and one before and after.
- The cookies are `Secure` on every environment except `local`, so they need `https` there.
- In production the React app and the backend must be on the **same site** (for example `app.example.com` and `api.example.com`). If they are on different sites, the browser will not send the cookie.
- Behind a proxy set `TRUST_PROXY` right. If not, the IP list and the rate limits see only the proxy's address.
- There is no `GET /internal/staff/me` route. The React app saves `{ username, role, expiresAt }` itself after the login. That is not secret: the cookie is the real login, and the backend checks the role on every admin route.

### Phase 3: managing staff

- Only an admin can create staff and change them. A `support` user gets 403.
- One action per `PATCH`. Every change ends all sessions of that user.
- An admin cannot disable himself. The last active admin can never be disabled, even if two admins try at the same moment.
- The admin knows the first password of every user he creates. Send it through a safe channel, not a group chat.
- A user locked by wrong tries shows `"isLocked": true` in the list. A new password unlocks them.

### Phase 4: support sessions

- The shop must be in MySQL with the status `installed` or `reinstalled`. The first install always happens through Shopify Admin.
- The support token ends at the same moment as the staff login. If staff open a shop at minute 29, they have 1 minute. With less than 30 seconds left, the backend refuses to open a shop.
- A support session of the role `support` is **view only**: only `GET` and `HEAD`. The role `admin` can also change data. The rule is in `verifySessionToken`, so it covers every route. A `GET` route must never change data. The role is read from the staff row on every request, so it cannot be faked in the token.
- Every change an admin makes in a support session is written to the server log: `[support] write staff=... shop=... METHOD /route -> status ip=...`. It never has the body or the query string. There is **no audit table**, so if the log is lost, the history is lost. Keep your server logs.
- The answer of `POST /internal/support/sessions` has `canEdit` (`true` for an admin). The React app uses it to show or hide the buttons that change data. The backend still checks every call.
- A support session skips the token exchange and the shop detail refresh. It only reads MySQL. For a `GET` route that calls the Shopify Admin API, the saved offline token is used. If that token is dead, the merchant must open the app once.
- The token is shown to the React app in the JSON answer. It must be kept only in `sessionStorage`, and never put in an address.
- The token works only on `/api`. It does not work as a staff cookie, and a staff cookie does not work as a support token.
- Each time a staff member opens a shop, one log line is written: `[support] staff=... shop=... ip=...`. Logins, wrong passwords and staff changes write `[staff] ...` lines. There is no audit table, so these log lines are the only history. They never contain a password or a code.
- The old standalone token is gone: the routes `GET /api/auth/standalone-token` and `POST /api/auth/standalone/revoke` do not exist, and the settings `STANDALONE_TOKEN_SECRET` and `STANDALONE_TOKEN_TTL_DAYS` are not used. The column `standalone_token_version` stays in `stores` but nothing uses it.