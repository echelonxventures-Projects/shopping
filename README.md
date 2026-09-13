# AetherCommerce — Single-Click Install & Test

Zero-hardcode, multi-tenant, multi-vendor commerce platform.
**Every route, policy, key, tax rate, price, and market is pack data — not code.**

## One Command

```bash
npm start
```

That's it. `npm start` installs dependencies if missing, boots all products as
plug-and-play modules, seeds a shoppable catalog, and serves the HTTP API.

**Testing URL:** http://127.0.0.1:8787

### Container (single command, no Node needed)

Any OCI-class runtime works — the `Dockerfile`/`docker-compose.yml` are
Reference Pack *instances* (container-class), not bindings. Docker-class:

```bash
docker compose up        # or: podman-compose up (podman-class, same OCI file)
# → http://localhost:8787
```

### 60-Second Test Drive (copy-paste)

```bash
# 1. REGISTER (creates your customer id + login token)
curl -X POST -d '{"email":"you@shop.test","password":"shopper123","name":"You"}' \
  http://127.0.0.1:8787/auth/register
# → note the token: data.session.token

# 2. BROWSE the seeded catalog
curl -H 'x-api-key: demo-shopper-key-0000' 'http://127.0.0.1:8787/search?q=aether'
# → note an offerId from the hits

# 3. ADD TO CART (Bearer = your login token)
curl -H "Authorization: Bearer <TOKEN>" -X POST \
  -d '{"line":{"offerId":"<OFFER_ID>","productId":"p1","title":"Aether Classic Tee","sellerId":"seller-1","price":25,"qty":2}}' \
  http://127.0.0.1:8787/cart/add

# 4. CHECKOUT — the full saga (reserve → authorize → capture → notify)
curl -H "Authorization: Bearer <TOKEN>" -X POST -d '{"idem":"shop-001"}' \
  http://127.0.0.1:8787/shop/checkout
```

## Demo Credentials (pack data: `services/gateway/packs/gateway-core.json`)

| Credential | Value | Use |
|---|---|---|
| API key (admin) | `x-api-key: demo-admin-key-0000` | full access incl. product upload |
| API key (shopper) | `x-api-key: demo-shopper-key-0000` | read-only + AI |
| Shopper login | `POST /auth/register` → `Authorization: Bearer <token>` | sessions (4h TTL) |

## Key Endpoints (full list: `GET /health` · spec: `GET /openapi.json`)

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` |
| Catalog | `POST /catalog/products`, `POST /catalog/offers`, `GET /catalog/buybox/:id` |
| Shopping | `POST /cart/add`, `GET /cart`, `POST /cart/update`, `POST /cart/remove`, `POST /shop/checkout` |
| Search | `GET /search?q=…` |
| Tax / Pricing | `POST /tax/compute`, `POST /pricing/quote` |
| Payments | `POST /payments/authorize` (token-only, SAQ-A) |
| Orders | `POST /orders`, `GET /orders/:id`, `POST /orders/:id/transition`, `GET /orders/:id/history` |
| Billing | `POST /monetization/subscribe|meter|invoice`, `GET /monetization/usage/:tenant` |

## Other Single Commands

| Command | What it does |
|---|---|
| `AETHER_PG_DSN=… npm start` | **distributed mode** — sessions, users, carts, search + rate limits shared across pods via the wire engine |
| `AETHER_TLS_CERT_FILE=… AETHER_TLS_KEY_FILE=… npm start` | **TLS + HSTS** (config names come from the gateway pack) |
| `npm run gameday` | real-cluster chaos drill (pack scenario + kubectl harness) |
| `npm start` | install-if-needed + boot + serve (the one-click) |
| `npm run deploy` | agnostic cluster deploy — runtime tooling resolved from the infra pack's `runtimeAdapters` (docker-colima-class / podman-kind-class / registry-class) |
| `npm test` | 394 tests — the whole platform proven in-process |
| `npm run demo` | scripted full purchase tour (no server) |
| `npm run lint` | doctrine gates (product law, hardcode bans) |
| `npm run typecheck` | strict TS across kernel + services |

## Seeded Demo Data

- **Products:** Aether Classic Tee ($25), Fleece Hoodie ($79), Cap ($19) — 50 stock each
- **Sellers:** `seller-1`, `seller-2` · **Tenant:** `demo-tenant`
- **Plans:** `plan_starter` $29 · `plan_growth` $199 · `plan_enterprise`
- **Markets (tax rules):** US 7% / US-CA 9.25% · EU VAT 20% incl. · IN · BR · AE

All state is in-memory (restart = fresh). Production swaps: KMS-backed keys,
wire-protocol engines, real PSP adapters — all Reference Pack changes,
zero code.

**The single living plan:** `docs/PLATFORM-PLAN.md` (Living-Document Protocol).
