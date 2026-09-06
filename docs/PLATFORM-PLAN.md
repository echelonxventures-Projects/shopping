# AetherCommerce — Global Multi-Tenant, Multi-Vendor E-Commerce Platform

**Plan Document — Epoch 2 (in-place upgrade of the v1.0 baseline — never a rewrite) — 06 Sep 2026**

A production-grade, Amazon-scale commerce platform supporting multi-tenancy (SaaS), multi-vendor marketplace (3P sellers + 1P retail), and multiple portals (Customer, Seller, Admin, Operations/Fulfillment, Support, B2B), built to compliance standards (PCI-DSS, SOC 2, GDPR, CCPA, ISO 27001, LGPD, DPDP, PDPA, PSD2/SCA, EU AI Act, HIPAA-class vertical packs). Global from the ground up: every market, every product type, every business rule, every technology choice — **all runtime configuration, zero hard coding**.

> ### Living-Document Protocol (in force forever)
> - **Single source of truth.** This is the one canonical plan document. No second doc, addendum, version archive, or parallel file will ever be created — all ideas from all contributors (human or agent) assimilate here via in-place edits.
> - **Upgrade-only.** The document evolves through targeted in-place edits that preserve and extend existing content. Wholesale rewrites are forbidden. Git history provides versioning.
> - **Roadmap sync rule.** Every requirement upgrade must, in the same change, upgrade §7 (Implementation Roadmap) so requirements and implementation sequence never drift apart.
> - **No-Final-State Clause.** Every state of this document is a bitemporal epoch with an open-ended validity window. "Final" is structurally meaningless — this protocol has no terminal state. Any doctrine, service, phase, or governance rule may be amended, extended, superseded, or deprecated at any time by any contributor, forever.

---

## 0. The Six Doctrines (Architecture Laws)

Every design decision in this platform is subordinate to these six laws. They are constitution-tier (T-C) content, amendable only through the Constitutional Amendment Protocol (§2).

1. **ECR Derivation — Entity, Context, Relationship.** Everything is an entity, context, or relationship. All domain concepts — products, markets, fees, portals, workflows, runtimes, ID schemes, governance itself — are runtime *data* derived from a small universal kernel, never code branches.
2. **Invariant-only Kernel.** Only universal truths are code: ECR primitives, double-entry accounting math, the bitemporal time model, tenant isolation, idempotency, causal ordering, and policy-check hooks. Everything else — including money-path entity types — is registry data.
3. **Market-as-Data.** Any country/region onboards as configuration + rule pack + adapter instance. Nothing market-specific exists in core; a new market is a config change, not a deploy.
4. **Bitemporal Everything.** `valid_from / valid_to + recorded_at` on every fact *and* every metadata definition (prices, fees, taxes, rules, schemas, markets, crypto schemes). Full point-in-time reconstruction; regulator-grade audit replay; safe reversal via epochs.
5. **Everything Billable, Sellable, Configurable.** One monetization kernel serves shoppers, tenants, sellers, and advertisers. Every capability registers as a billable, meterable, sellable, entitlement-gated resource; one offer → order → payment → ledger backbone for all audiences.
6. **Total Agnosticism.** No technology is binding — not language, framework, database, cloud, runtime, tool, or vendor. Open-standard contracts are the only invariant integration surface; every implementation is a swappable registry entity (adapter pack) admitted through a generated conformance harness.

## 1. Business Model & Portals

| Portal | Audience | Key Capabilities |
|---|---|---|
| Storefront (Web/PWA/App) | Shoppers (B2C + B2B) | Browse, search, cart, checkout, subscriptions, loyalty, reviews, returns |
| Seller Portal | 3P vendors | Onboarding/KYC, listings, inventory, orders, shipping, payouts, analytics, ads |
| Admin Portal | Platform ops (tenant admins + super admins) | Tenant lifecycle, catalog moderation, disputes, finance, risk, content mgmt |
| Ops/Fulfillment Portal | Warehouse & logistics staff | Pick/pack, SLA, carrier handoff, returns intake |
| Support Portal | Customer service | Order lookup, refunds, tickets, chat, audit trail |
| B2B Portal | Business buyers | Quotes, POs, approval workflows, net terms, bulk pricing |

**Tenancy model:** Tenants = independent retail brands/enterprises. Vendors can sell across tenants. Each tenant gets: themable storefront (custom domain), own catalog, pricing, promotions, payment config, and staff — all isolated by tenant ID at data + cache + queue + search index + **cryptographic key** level (§4.5). The tenant × market activation matrix decides where each tenant sells (Market Registry, §3.2b).

## 2. Architecture Overview

**Style:** Microservices on a Kubernetes-class runtime contract (any RuntimeTarget per §2.7), event-driven (Kafka-class event backbone), CQRS where read-heavy (catalog, search, orders history), saga orchestration for distributed transactions (checkout, order fulfillment).

```
[Web/PWA] [Mobile Apps] [Seller Portal] [Admin/Support/B2B Portals]
        \            |             /
        [CDN + WAF + Bot Mgmt + Edge Cache]
                 |
          [API Gateway (Kong/Apigee)]
   (JWT verify, tenant resolution, rate limits, quotas)
                 |
   [Service Mesh — mTLS: Istio/Linkerd]
                 |
  ┌──────────────┼──────────────────────────────┐
  │ Core Commerce │ Marketplace  │ Fulfillment  │
  │ Catalog      │ Seller/KYC   │ Inven/WMS    │
  │ Cart/Checkout│ Commissions  │ Ship/Track   │
  │ Orders Saga  │ Payouts      │ Returns      │
  │ Payments     │ Disputes     │ Carrier API  │
  │ Promotions   │ Ads/Sponsored│              │
  │ Search (CQRS read models from OpenSearch)  │
  └──────────────┼──────────────────────────────┘
                 |
  [Event Backbone (Kafka-class)] → [Stream/BI pipeline → Lake → BI/ML]
                 |
  [Relational | KV-Cache | Search | Object Store | Analytics-Columnar]  — Storage SPI adapters
```

**Reference Technology Pack (default, swappable — not an architectural mandate):**
Per Doctrine 6 (Total Agnosticism), every technology below is the *default Reference Pack* — a registry-configured selection replaceable by any adapter pack passing the conformance harness (§2.7). New stack elements register as config, never as kernel changes.
- Frontends: Next.js-class SSR/SSG framework (PWA), React Native-class mobile shell
- Backend: Node.js-class service runtime; Go-class high-throughput runtime; Python-class ML runtime — all RuntimeTarget adapters
- Data engines: PostgreSQL-class relational, Redis-class KV, OpenSearch-class search, Kafka-class stream, ClickHouse-class analytics, S3-class object — Storage SPI adapters (§2.7)
- Infra: Kubernetes-anywhere contract (any cloud / on-prem / edge), Terraform-class IaC, ArgoCD-class GitOps, multi-AZ → active-active multi-region for DR
- Observability: OpenTelemetry contract → Prometheus/Grafana-class, Loki-class logs, Sentry-class errors, Jaeger-class traces; SLO error budgets
- Payments: multi-PSP via adapter routing (Stripe-class + Adyen-class defaults); PCI-DSS **SAQ-A** (card data never touches platform systems — enforced at registry level, §4.5)

### Multi-Tenancy Strategy
- **Tier 1 (SMB):** Pool model — shared DBs, `tenant_id` column + relational **Row-Level Security** enforced on every connection (plus tenant crypto-isolation, §4.5); cache key prefixes `t:{tenant}:`; event headers with tenant context.
- **Tier 2 (Enterprise):** Bridge — shared cluster, schema-per-tenant.
- **Tier 3 (VIP):** Silo — dedicated DB + optional dedicated K8s namespace (regulatory/data-residency requirement).
- Tenant resolution: custom domain → tenant mapping service (cached). All downstream context via `X-Tenant-ID` (signed at gateway).
- Noisy-neighbor protection: per-tenant rate limits, queue fairness, DB connection quotas, per-tenant search shard routing option.

### 2.5 Zero-Hard-Coding Architecture & Tiered Change Control

**Everything-is-Config doctrine:** markets, commissions, taxes, rules, fees, workflows, state machines, product types, ID schemes, crypto policies, runtimes — all runtime data, versioned + validated + auditable, never code branches.

- **Config Store**: typed config schemas, versioned, environment-scoped, dry-run/preview mode, approval workflow, change-audit trail; inheritance chain Platform default → Tenant → Market → Vendor override.
- **Tiered Change Control:**

| Tier | What | Who | Gate |
|---|---|---|---|
| **T-C Constitutional** | Doctrines, governance, crypto floors, resolution-visibility policy | Platform constitution | Automated verification (simulation + conformance + impact analysis) → M-of-N super-admin quorum with hardware passkeys, dual control → epoch enactment → hash-chained immutable audit; auto-rollback circuit-breaker on SLO breach |
| **T0 Kernel** | ECR primitives, invariants, contracts | Kernel team | CI, semver, pen-test |
| **T1 Platform** | Platform entity types, behavior packs, reference packs | Platform engineering | Approval + simulation harness |
| **T2 Tenant** | Markets, fees, rules, themes, policies | Tenant admins | Validation + preview, self-serve |
| **T3 End-user** | Vendor/user scope config | End users | Policy envelopes |

- **Constitutional Amendment Protocol**: amendment proposals are entities; verification is fully automated; authority is M-of-N hardware-key quorum (no single-person authority ever); enactment creates a new registry epoch; bitemporality makes reversal safe; the constitution governs itself (same ECR model).
- **Constitutional Crypto Floors (inviolable minimums, §4.5):** no card data in platform systems ever; TLS 1.3+ floor; encryption-at-rest mandatory; PII field-encryption mandatory; minimum key strengths; tamper-evident audit for money paths. Configuration selects *above* the floor, never below — validated at config-publish time.
- Rule packs and config packs are validated against a simulation harness before publish (catches bad commission/tax/pricing rules pre-production).

### 2.6 ECR Kernel (Entity–Context–Relationship)

The platform core is a metadata-driven kernel where **no domain concept is hardcoded** — clothing brands, electronics, groceries, marketplaces, and any future vertical are pure data derivations.

**Universal primitives (Tier-0 code — the only code):**
- **Entity Type** — runtime-defined type with JSON-Schema-typed attributes and inheritance (Apparel ⊂ Product ⊂ Sellable ⊂ Resource), versioned by epoch
- **Relationship** — directed, typed, cardinality edges (variant-of, sold-in, fulfilled-by, styled-with, parent-org, deployed-on, uses)
- **Context** — resolution frame: tenant × market × locale × channel × audience × time; selects which entity version, behavior, rule, and price applies
- **Behavior Pack** — pluggable capabilities bound to entity types via config (fulfillment, entitlement, pricing, tax, lifecycle)
- **Rule** — declarative logic (decision tables/DSL) evaluated within a context
- **Workflow / State Machine** — config-defined lifecycle per entity type (orders, KYC, RMA — all data)
- **Policy** — visibility + config inheritance (Platform → Tenant → Market → Vendor); permissions and tenancy isolation as data

**Kernel components:**
| Component | Role |
|---|---|
| **Metadata Registry** | Entity types, attribute schemas, behavior bindings — source of truth, epoch-versioned |
| **Context Resolver** | Resolves applicable version/behavior/rule/price per context frame; <5ms hot-path budget via multi-level caches (§5) |
| **Relationship Graph Store** | Typed edges for catalog graphs, org hierarchies, order trees, cross-sell links, deployment topology |
| **Behavior Runtime** | Executes behavior packs against entity instances |
| **Codegen Pipeline** | Compiles registry epochs into optimized artifacts: DB tables/indexes (no EAV tax on hot paths), OpenSearch mappings, typed APIs/SDKs, admin CRUD, model-driven portal UIs |
| **Model-Driven UI Runtime** | All admin/seller/ops/support/B2B portals render from entity schemas + behavior packs (forms, tables, workflows, dashboards auto-generated). Storefront is **hybrid**: registry-driven composition + hand-crafted high-performance storefront component library (conversion-grade UX) |

**"Full ontology everywhere" made safe (mandated decisions):**
1. **Compiled projections** — registry is source of truth; physical tables/indexes/search mappings auto-generated per epoch; no EAV-query performance tax
2. **Schema-version pinning** — every transaction/journal entry records registry epoch + entity schema version used → deterministic audit replay under mutable schemas ("what did this fee *mean* on March 3")
3. **Registry-level DLP** — attributes carry classifications (PII, card-data-prohibited, public…); card-data-typed attributes are rejected at registry write time → PCI SAQ-A scope is permanent by construction
4. **Reprojection/backfill engine** — epoch migrations of billions of rows without downtime; explicit worker fleet design (§13)

### 2.7 Agnosticism Layer (Total Agnosticism)

Per Doctrine 6: no technology is binding. Contracts are the only invariant integration surface.

- **Contract-First Kernel** — Protobuf/Avro-class data contracts, CloudEvents events, OpenAPI/AsyncAPI APIs, OpenTelemetry telemetry, SPIFFE workload identity, W3C trace context. Any language/stack can implement or consume any service through registry-published contracts.
- **Reference Packs** — default stacks (§2 Reference Pack) are swappable config: new language, DB, cloud, or tool = register adapter pack + pass conformance → zero kernel changes.
- **Runtime-as-Entity** — `RuntimeTarget` is an entity type with capability descriptors (compute class, scaling semantics, network model, placement constraints, TEE capability). K8s-anywhere is the *default* target; VMs, bare-metal, serverless, WASM/edge are interchangeable adapter packs. Deployment is a relationship: `Service —deployed-on→ RuntimeTarget`, resolved per context.
- **Storage SPI (engine per workload)** — projection targets are pluggable engine classes (relational, document, search, KV, graph, time-series, stream, object, ledger) with capability negotiation per workload; per-tenant override at silo tier.
- **Versioning-as-Data** — API/SDK/schema/contract versions are registry entities with bitemporal lifecycles, compatibility linters, deprecation policies → infinite additive expansion, no breaking changes.
- **Conformance Harness** — every adapter pack must pass the *generated* contract-test matrix before registration. Unbounded adapters, guaranteed interoperability — this is what makes "infinite expansion" safe.

## 3. Domain Services & Features (End-to-End)

### 3.1 Identity & Access (IAM)
- Customer accounts: email, phone-OTP, Google/Apple/FB, passkeys (WebAuthn), passwordless
- Seller/admin: SSO (SAML/OIDC), SCIM provisioning, mandatory MFA (TOTP/hardware keys)
- RBAC + ABAC (roles × tenant × resource scope); just-in-time access elevation for ops staff w/ session recording
- Fraud: device fingerprinting, velocity checks, credential-stuffing protection, bot mitigation at edge

### 3.2 Catalog & Product Type Registry
- Products → variants → options; category tree; attribute schemas per vertical (extensible via JSONB + JSON Schema validation) — all ECR entity types, inheritance-driven
- **Product Type Registry — all types day-1 via behavior packs (each type = schema template + fulfillment behavior + entitlement behavior + validation pack, composed via config):** physical, digital (licenses/entitlements/downloads + DRM/rights management: device limits, lending), subscriptions, services/bookings (calendars/scheduling), gift cards, kits/bundles, perishables (lot/expiry/cold chain), regulated (age-verify gates), configurable/CPQ (option dependency rules), freight/oversized, used/refurbished/collectibles (condition grading, C2C selling), auctions/bidding, rentals/leasing (borrow-return), trade-in/buyback, group buying, live-stream & social commerce, AR try-on/3D product views, voice commerce, charity giving, fractional subscriptions. New vertical (e.g., a clothing brand) = one config graph: entity type + attributes (size/color/fabric) + relationships (variant-of, styled-with) + context bindings (per-market size charts, prices) + behavior packs — zero deploys.
- **Health vertical compliance pack:** HIPAA-class (BAA, PHI vaulting, minimum-necessary access), Rx verification flows, pharmacy serialization (DSCSA-class) — constitution-defined pluggable vertical pack.
- Cross-border-ready from day 1: HS codes + country-of-origin mandatory in catalog schema (landed-cost activation later is config-only).
- Rich media: adaptive images/video transcode pipeline (object store + per-resolution renditions), alt-text enforced (a11y)
- Listings: 1P retail + 3P seller offers on shared product pages (buy-box: price + shipping + seller rating algorithm)
- Moderation workflow: prohibited items, IP-infringement takedowns, AI pre-screening + human review queue, UGC media content moderation at scale
- I18n: translated content, currency, units (metric/imperial), RTL support

### 3.2b Market Registry & Globalization Layer
- **Market Registry — Market-as-Data**: each Market = config entity (country/region granularity, e.g., US-state nexus level): locales, currencies, tax regime descriptor, payment-method set, shipping constraints, compliance rule-pack references, capability flags (B2B allowed, BNPL, COD, cross-border DDP…). Tenant × Market activation matrix. Onboarding a new country = config + rule pack + adapter instance — zero core-code changes.
- **Adapter SPI framework** (ports & adapters): internal interfaces for TaxProvider, EInvoiceFormat, Carrier, AddressFormat, PaymentRail, ComplianceCheck, KYC/Identity. New market = select adapter + config; new adapter only for genuinely new mechanisms.
- **Market/Geo negotiation**: IP, headers, account preference, billing/shipping divergence → market resolution; market gating at gateway; currency & language switching.
- **Localization**: TMS + machine translation with human-review queue, per-tenant translation memory, locale fallback chains (fr-CA → fr-FR → en), RTL, localized CS.
- **Landed Cost / Cross-border**: architecturally present, feature-flagged OFF at launch (decision deferred); HS codes + COO captured day-1; DDP/DAP/de-minimis calculation interface, customs docs, brokers — activate via config when decided.

### 3.3 Search & Discovery
- OpenSearch: faceted search, fuzzy/typo tolerance, synonyms (per-tenant dictionary), ranking with ML (LTR) on relevance + conversion + sponsored placement (clearly labeled)
- **Per-language analyzers** (CJK tokenization, Arabic stemming, Indic processing) — analyzer selection per market/locale via config
- Autosuggest, federated search (products, categories, content, **any U²ID — global resolution, §3.15**), zero-results recovery
- Event pipeline (clicks → carts → purchases) → near-real-time index updates via event stream
- Personalization: session-based recs (similar items, "customers also bought", recently viewed) — per-tenant consent honoring (GDPR)
- **AI Commerce**: visual search (search-by-image), conversational shopping assistant (LLM, guardrailed, EU AI Act aligned), agentic commerce (machines buying on users' behalf; agent identity/delegation credentials, signed authorizations — §4.5)

### 3.4 Pricing, Promotions & Tax
- **Bitemporal multi-currency price lists** (valid-time + transaction-time; point-in-time dispute reconstruction), per-tenant/market pricing, sale/campaign scheduling
- Coupons, %/absolute-off, bundle pricing, BOGO, tiered B2B pricing, promo-stacking rules engine
- Sponsored listings ads platform (CPC bidding) for sellers — separate revenue line
- **Tax Engine v2**: inclusive vs exclusive display (EU gross prices), marketplace-**facilitator** liability mode (platform remits seller tax), VAT-ID validation + reverse charge, exemption certificates, **e-invoicing adapters** (India IRN, Italy SDI, Poland KSeF, Mexico CFDI), refund pro-rating — all via TaxProvider/adapter SPI per market
- Tax rule packs are Market Registry config: US sales-tax nexus, EU VAT (OSS), India GST, and every future regime — adapter-selected, not hardcoded

### 3.5 Cart & Checkout
- Guest + logged-in carts (Redis, 30d TTL), merge on login, cross-device cart via identity
- Multi-vendor cart → split into vendor sub-orders (one payment authorization, N fulfillment entities)
- Idempotency keys on all checkout steps; optimistic concurrency on cart version
- Address validation (address-autocomplete adapter), fraud screening (fraud-platform adapter: Sift/Stripe Radar-class) pre-auth
- One-click checkout, saved wallets (PSP tokens), wallets (Apple/Google Pay), BNPL (Affirm/Klarna), gift cards, loyalty points redemption
- Checkout conversions: A/B testing infra, abandoned-cart automation

### 3.6 Monetization Stack (Payments, Ledger, Commissions, Billing)

One monetization kernel serves all audiences — shoppers, tenants, sellers, advertisers — with one offer → order → payment → ledger backbone.

**Payments & Ledger (unchanged baseline):**
- Multi-PSP routing (cost/geo/success-rate based) via adapter table; tokenized payments only — **PCI-DSS SAQ-A scope, enforced at registry level (§4.5)**; local rails via adapter config (UPI, PIX, iDEAL, GrabPay, Alipay/WeChat, COD — §3.8)
- Double-entry internal ledger — every money movement (charge, refund, commission, payout, chargeback) is an immutable journal entry; daily reconciliation against PSP settlement files (auto-exception queue); **multi-region model: tenant home-region-pinned serializable writes + global settlement service for cross-region** (locked decision)
- Chargebacks/disputes: representment workflow, evidence templates, seller liability rules
- **FX settlement for cross-region seller payouts** (local-currency payouts, hedging hooks)

**Commission & Fee Engine (Amazon-style full stack, 100% config):**
- Unlimited fee dimensions: category × vendor-tier × market × price-band × fulfillment-mode × tenant… — data-driven fee matrices; fee stack = referral % + per-order fulfillment + storage + subscription + service charges, each a configurable rule; bitemporal (fee version at order time = fee charged)
- Co-sell / affiliate / multi-level commission graphs; all entries → same ledger with per-fee GL dimensions for finance reporting

**Billable Resource Registry & Metering/Rating:**
- Every capability registers as a **billable resource** with metering dimensions — orders, GMV, API calls, storage GB·days, emails, SMS, portal seats, search/recs queries, fulfillment picks, ad impressions, labels, webhook deliveries, **vanity IDs**
- All usage flows as events → rating engine; rate plans are pure config: flat, per-unit, tiered, volume, graduated, % of GMV, minimums/caps, free tiers, bundles — bitemporal (rate at time of use = rate billed)
- Continuous invoice previews; rated usage lands in the same double-entry ledger with fee-type GL dimensions

**Offer/SKU Abstraction (everything sellable):** anything sellable is an **Offer** in one catalog engine, targeted per audience — shoppers (products, all types), tenants (platform tiers, add-ons, feature unlocks, marketplace services), sellers/advertisers (fulfillment, storage, ads, subscriptions). Portals present different catalogs of the same backbone.

**Entitlement Engine:** purchases → entitlement grants (features × quotas × expiry) evaluated at runtime with cached grants (short TTL) — feature access is never hardcoded, always entitlement-checked (generous free-tier defaults prevent accidental paywalls).

**SaaS Billing (platform revenue — hybrid tier + usage):** tier subscription + usage metering; dunning, proration, tenant invoices, credit notes, revenue-recognition hooks.

**FinOps:** per-tenant infra cost attribution (the mirror of metering) feeding tier pricing and unit economics.

**Tenant/Seller Finance & Analytics Portal:** P&L views, settlement reports, self-serve BI on the analytics stack.

- Payouts: sellers' available balance = collected − commission − returns hold; escrow/rolling reserves for risk; instant payouts as premium feature (all fee/payout rules are Commission Engine config)

### 3.7 Inventory & Orders
- Real-time availability (Redis + async DB), reservation TTL at checkout, oversell protection via atomic decrements; per-warehouse/DC stock
- Order state machine: CREATED → AUTHORIZED → CONFIRMED → PARTIALLY_SHIPPED → SHIPPED → DELIVERED → CLOSED (+ CANCELLED/RETURNED per sub-order) — event-sourced transitions, full audit
- Saga: payment capture, stock commit, notification, per-vendor splits with compensating actions (auto-refund on failure)
- SLAs per vendor class; split shipments; substitutions rules

### 3.8 Fulfillment, Shipping, Logistics v2 & Returns
- **Config-driven carrier registry** — global + regional carriers (Delhivery, Aramex, Ninja Van, Correios…) as Carrier adapters; rate shopping, label generation (EasyPost/Shippo-class adapters), tracking webhooks → proactive status page + notifications; delivery-exception handling
- **Multi-DC, vendor self-ship, 3PL integrations, bonded warehouses**, multi-node 3P fulfillment (FBA-class service as a billable offer); lockers/pickup points; BOPIS/ship-from-store via Geo Service (§3.17)
- **Cash on Delivery (COD)**: reconciliation pipeline, rider/delivery-partner flows, emerging-market UX — a PaymentRail adapter
- Offline/low-connectivity storefront mode (emerging markets)
- Returns: RMA wizard, restocking, refunds/replace flows, returnless refunds (low-value), grading (sellable/refurb/outlet/liquidate), serial-returner fraud detection; buyer-abuse detection (promo/returns abuse)
- OMS dashboards for vendors + tenant ops
- **Unified Commerce / POS**: POS terminal entity, in-store pickup/returns, offline-first terminals, RFID — extends Geo/BOPIS into full omnichannel

### 3.9 Reviews, Q&A & Trust
- Verified-purchase reviews, ratings breakdown, media reviews (photos/video)
- Sentiment analysis (ML) → auto-surface issues; seller rating → buy-box factor
- Seller trust: performance scorecards (defect rate, cancellation, SLA adherence) → enforcement ladder

### 3.10 Support & CS
- Omnichannel: chat (with AI triage → human), email, phone-in (Twilio), social; order-context-aware agent workspace
- Self-service: order tracking, returns initiation, invoice download, refunds where policy allows
- Ticket SLAs, escalation, CSAT/NPS

### 3.11 B2B
- Business accounts w/ multi-user, approval roles, purchase workflows, quotes/RFQ, net-terms (credit checks via credit bureaus), PO uploads, punchout/cXML support (for enterprise procurement), tiered contract pricing

### 3.12 Loyalty, Subscriptions & Growth
- Loyalty: points accrual/redemption, tiers; gift card issuance (PCI-compliant codes)
- Subscriptions: scheduled orders (Subscribe & Save), memberships (tenant-branded "Prime-like" tier: free shipping/ streaming perks), dunning mgmt
- Marketing: transactional + lifecycle email/SMS/push (Braze-class), referral programs, abandoned-checkout flows, per-tenant campaigns

### 3.13 Notifications & Webhooks
- Template engine, per-tenant SMTP/sender identity, multi-language
- Public developer API + signed webhooks (HMAC) for vendors/integrations (ERP, PIM)

### 3.14 Data, ML & Recommendations Platform
- **Recommendations architecture:** candidate retrieval (search/graph/behavioral) → LTR ranking → business re-rank (diversity, inventory-aware, sponsored-blend — labeled), cold-start heuristics, session-based real-time recs, explanation strings; consent-gated per tenant/market
- Event lake (ClickHouse + S3/Iceberg) — funnel, cohort, LTV, vendor health
- Feature store → recommendations, dynamic pricing guardrails, fraud, demand forecasting (inventory planning), search LTR
- All ML gated by tenant consent flags (privacy-safe personalization); **EU AI Act alignment** — AI system classification, transparency for recs/assistant/risk scoring

### 3.15 Universal ID, Dictionary & Resolution System (U²ID / U²D)
The identity backbone: every entity instance auto-receives a universal, eternally-resolvable ID; every ID (internal or external alias) resolves through one dictionary.
- **ID-Scheme Registry — infinite & unlimited (ECR):** ID schemes are registry entities — format grammar, alphabet, check digits, prefix namespaces, sortability, opacity, security posture, generation policy — all config dimensions (UUIDv7/ULID-class, opaque-random, dual-form sortable-inner/opaque-public, check-digit'd, namespaced, federated/external-bridged); scheme per entity type; bitemporal (old IDs resolve forever, never rewritten); a Reference Pack default exists as swappable config
- **Auto-allocation:** kernel allocates a U²ID at entity creation per its type's scheme; reserved namespaces; **vanity IDs / branded short codes** — all monetization models coexist as configurable rate-plan entries (billable, free-within-policy, or auto-only — per tenant)
- **U²D (the Dictionary):** one global, bitemporal registry mapping every universal ID + every external alias (GTIN/EAN/MPN/ISBN, tracking codes, PO numbers) → entity type + epoch + context; never reused; merges/aliases map to one canonical entity; retired-not-deleted (audit-safe)
- **Global resolution search:** any portal search bar accepts any ID → instant entity resolution + cross-entity graph view (order ↔ product ↔ tenant ↔ ledger), KV hot-path + search-engine fuzzy/alias lookups; **policy-scoped** — resolution-visibility rules are T-C constitutional policy entities (strict tenant isolation, opt-in marketplace sharing, or role-filtered global — all constitutional configurations)
- **Stability anchor:** U²IDs are invariant across schema epochs; journal entries, bitemporal replay, SEO canonical URLs, and audit reconstruction join on U²ID
- **Identity resolution (from GID):** guest→user stitching, device/account graph (consent-gated), geo-identity profiles, B2B group identity — sub-capabilities of U²D
- Security: enumeration protection, per-scheme info-leak controls, resolution rate limits, audit on sensitive-ID resolution

### 3.16 Rules Engine
- Data-driven decision tables per market: item restrictions (lithium batteries, age-restricted, dual-use), prohibited categories, export controls + denied-party screening, consumer-law return windows (EU 14-day withdrawal, AU ACL…), per-tenant overrides within legal floors
- Rules evaluated within context frames; bitemporal; simulation-harness validated; feeds Decision-Explainability Service (§10)

### 3.17 Geo Service
- Zip/pin/postcode zone resolution → tax/shipping/delivery-SLA zones; geofenced rules (restrictions, promos), geo-targeted promotions; geo-IP → market negotiation (with §3.2b); ship-from-store routing; per-session geo-profile (U²D geo-identity)

### 3.18 SEO Platform
- SSR/SSG rendering, sitemap sharding (10M+ SKUs), hreflang per market, schema.org Product/Offer, per-tenant custom-domain robots/canonicals, Core Web Vitals SLO, editorial CMS + landing pages, canonical URLs built on U²ID

### 3.19 Experimentation Platform
- Feature flags, A/B/n, governed rollout policies — first-class service; experiments are registry entities (bitemporal, per-tenant/market scoping); integrates with release canaries

### 3.20 Onboarding & Migration
- Tenant/seller onboarding tooling; catalog/order/customer import from Shopify/WooCommerce/Magento-class platforms; bulk tooling; progress-safe migration with reconciliation reports

### 3.21 App Marketplace & Developer Ecosystem
- Extension/app marketplace, partner apps, developer portal with sandboxes, signed webhooks (HMAC), public APIs (versioned as data, §2.7), monetized distribution via Monetization Stack

### 3.22 Shopper Features — Wishlist, Gifting & Trust
- Wishlists, gift registries, gifting flows (messages, scheduled delivery, receipts hiding prices)
- Review integrity: fake-review detection, incentivized-review policy enforcement
- Anti-counterfeit serialization (Transparency-style codes) as a billable offer
- Buyer-abuse detection (promo/returns abuse) — shared with §3.8

## 4. Security & Compliance

### Security (Zero-Trust)
- Edge: WAF (OWASP Top 10 + custom rules), DDoS protection (Cloudflare/AWS Shield-class adapters), bot detection, per-tenant rate limits
- mTLS everywhere (mesh), zero-trust service identity (SPIFFE), network policies (default-deny), no public DBs
- Secrets: KMS/Vault, rotation, short-lived credentials (IRSA); no secrets in env/code — CI secret scanning
- AppSec: SAST + DAST + SCA in CI, annual pentest, bug bounty, dependency patch SLAs
- Data: TLS 1.3 in transit, AES-256 at rest, field-level encryption for PII, tokenized vault for sensitive IDs, pseudonymized analytics
- AuthN/AuthZ: OIDC, passkeys, MFA mandatory for all privileged users; session binding, replay protection; least privilege; audit every privileged action
- DR: RPO 5min / RTO 1h, active-active multi-region, quarterly failover drills, chaos testing

### Compliance Matrix
| Standard | How achieved |
|---|---|
| PCI-DSS v4.0 | SAQ-A — PSP-hosted payment fields + tokenization; annual AoC; registry-DLP makes scope permanent (§4.5) |
| SOC 2 Type II | Control framework from day 1; continuous evidence collection; annual audit |
| GDPR / UK-GDPR | DSR APIs (export/erasure) per tenant, data residency controls, DPA, sub-processor registry, 72h breach notification runbook |
| CCPA/CPRA | Do-not-sell/personalization opt-outs per tenant, GLBA-like data controls |
| LGPD (Brazil) / DPDP (India) / PDPA (Thailand+SEA) | Regional consent + DSR via the same consent/DSR services; residency cells per region |
| PSD2 / SCA | Strong Customer Authentication flows in EU checkout (PSP-adapter-driven) |
| EU AI Act | AI-system classification, transparency for recs/assistant/risk scoring, human-oversight hooks (§3.14) |
| HIPAA-class (vertical pack) | BAA, PHI vaulting, minimum-necessary access, Rx verification, DSCSA-class serialization (§3.2 health pack) |
| Consumer law (per market) | EU 14-day withdrawal, AU ACL, etc. — Rules Engine rule packs (§3.16) |
| E-invoicing mandates | IRN/SDI/KSeF/CFDI adapters (§3.4 Tax Engine v2) |
| Accessibility | WCAG 2.2 AA storefront + portals; automated axe tests in CI |
| Product safety | Prohibited items policy, recall workflow (mass order lookup + block + notify) |
| Taxes/Anti-fraud | KYC/AML for sellers (Onfido/Persona-class adapters), sanctions screening, OFAC lists; marketplace-facilitator registrations (§13) |
| Crypto floors | Constitutional crypto minimums (§4.5) — configurable above, never below |

### 4.5 Cryptography & Encryption Architecture (fully configurable, above constitutional floors)

**Crypto-agility as data:** `CryptoScheme` registry entities — algorithms, suites, key lengths, protocols per purpose (in-transit, at-rest, field, signing, hashing), bitemporally versioned, swappable via epoch without redeploy; PQC-ready by construction.

**Key hierarchy & ownership (all models as config):**
- Regional KMS masters → per-tenant KEKs → per-purpose DEKs → field keys; HSM root (FIPS 140-3); automated rotation; split-knowledge ceremonies for constitutional keys
- `KeyPolicy` per tenant × market × data class: platform-held (default), **BYOK** (tenant-managed via KMS integration), **HYOK** (tenant-held keys, platform never sees them) — entitlement-selectable, monetizable

**Tenant crypto-isolation:** silo/enterprise tiers get distinct key material — cross-tenant leakage becomes cryptographically impossible (defense-in-depth under RLS); crypto-shredding erasure trivial and provable.

**Every-level encryption mandate (enumerated, testable via conformance):**
- In transit: TLS 1.3+ on all links — including event-stream topics, caches, search inter-node, DB connections, backup/replication links; HSTS preload, DNSSEC, mobile cert pinning, ACME automation
- At rest: encrypted volumes, snapshots, PITR backups, cross-region replicas, **search indices, cache entries, analytics stores, logs** — no service ships unencrypted (generated conformance tests enforce)
- PII fields: field-level encryption + **searchable encryption** (blind-index/deterministic-key pattern via PII vault for lookup fields; per-classification registry policy)
- Audit: hash-chained, key-signed, tamper-evident logs — `AuditGuarantee` levels (batch-integrity → hash-chained → signed → notarized/anchored) selectable per tenant × entity-type; financial + constitutional records default to strongest
- Event bus: encrypted payload enforcement for classified attributes (registry-DLP)

**Confidential computing (all levels as config):** `TEEPolicy` per workload × tenant — no-TEE, TEE-for-sensitive-paths (payments, PII vault, KYC — mandated), TEE-everywhere; TEE is a RuntimeTarget capability flag (any cloud's enclave tech plugs in as adapter — agnosticism preserved).

**Post-quantum readiness (all postures as config):** classical-only, hybrid (X25519+ML-KEM-class), full-PQC — selectable per purpose and endpoint; **CBOM** (cryptographic bill-of-materials: algorithm × location × purpose × data class) auto-generated from the registry; PQ-readiness scorecard; migration = epoch change.

**Constitutional Crypto Floors (inviolable, T-C):** no card data in platform systems ever (PCI SAQ-A permanent); TLS 1.3+ floor; encryption-at-rest mandatory; PII field-encryption mandatory; minimum key strengths; tamper-evident audit for money paths. **Configuration selects above the floor, never below** — validated at config-publish time by the simulation harness.

**Performance:** envelope-encryption with hot-path key caching — crypto latency budgets in §5 SLOs (~zero added P95).

**Agentic-commerce credentials:** agent identity/delegation tokens, signed authorizations with scoped spending/policy limits (with §3.3 AI commerce).


- PII taxonomy + data map; consent service (purpose-based consents); PII vault (encryption + access logging)
- Right-to-erasure with event-sourced system: crypto-shredding for tenant-level deletion; backups scoped to retention windows
- Regional data routing (EU tenant → EU cells; India → India data centers)

## 5. Non-Functional Requirements (SLOs)

| Metric | Target |
|---|---|
| Availability (storefront/checkout) | 99.95% (checkout 99.99%) |
| Latency | P95 < 300ms API; P99 < 800ms (read), < 1.5s (write) |
| Scale target (Yr1) | 100M SKU/tenant set, 10M SKUs hot; 50k orders/hr peak (flash-sale: 250k/hr burst), 1M concurrent sessions |
| Search | P95 < 150ms; < 1s index freshness |
| Data durability | 11 9's (object store), PITR backups, 30-day event archive |
| **Kernel: context resolution** | P95 < 5ms (cached) on hot paths; multi-level cache invalidation < 1s |
| **Kernel: registry reads** | P99 < 15ms local replica; registry HA (no SPOF) |
| **Cryptography: envelope encryption** | ~0 added P95 via hot-path key caching; key-cache hit ratio > 99.9% |
| **U²ID allocation** | P99 < 10ms; collision-free without coordination (scheme-dependent) |
| **Entitlement checks** | P99 < 5ms cached (short-TTL grants) |
| **Model-driven portal pages** | P95 < 400ms rendered (admin/seller/ops/support/B2B) |

Capacity strategy: aggressive edge/CDN caching for catalog/media; graceful degradation (static catalog fallback if search is down; async order confirmation if email fails — never block checkout).

## 6. DevOps & Delivery
- **GitOps:** trunk-based, PR gates (unit/integration/E2E, SAST, secret scan, preview env per PR), ArgoCD-class progressive rollout (canary 1%→10%→50%→100% w/ auto-rollback on SLO breach)
- **IaC:** Terraform-class modules per region; drift detection; multi-cloud capable via Runtime-as-Entity (§2.7); Crossplane-class cloud-resource config-as-data; sovereign-cloud RuntimeTargets
- **Config CI:** every config-pack change runs validation + simulation harness + conformance tests in CI before publish; registry-epoch stamping on all artifacts
- **Conformance harness:** generated contract-test matrix per adapter pack (runtimes, storage engines, PSPs, tax providers, carriers, crypto schemes) — admission gate for all adapters
- **Environments:** dev → staging (prod parity) → prod; ephemeral preview envs; **seller/developer sandboxes**; synthetic PII-safe test-data generation (format-preserving encryption option)
- **Testing pyramid:** 70% unit / 25% integration (Testcontainers-class) / 5% E2E (Playwright-class); contract tests between services; **generated contract-test matrix per behavior pack**; load tests (k6-class) before every major release; synthetic canaries in prod; **golden-scenario library + financial invariant tests** (§11)
- **Runbooks + on-call:** SLO-based paging (PagerDuty-class); blameless postmortems; quarterly game days; **break-glass emergency governance** (time-boxed, audited, auto-expiring elevated access)

## 7. Implementation Roadmap (re-synced for true-everything-day-1 — 36 months)

> Locked scope decision: **all product types, all packs, all markets production-enabled from the first major gate** (walking-skeleton *architecture*, everything-day-1 *production*). Consequences accepted: Phase-1 gate at Month 18–24; peak team ~90–120; budget envelope ~$300–400M class; procurement (§13) starts Month 1 and is co-critical-path with the kernel.

### Phase 0 — ECR Kernel & Contracts (Months 1–6)
Kernel primitives (entity/context/relationship runtime), metadata registry + epoch model, context resolver, behavior runtime, codegen pipeline (compiled projections, typed SDKs), model-driven UI renderer v0, config store + tiered change control + **constitution v1 ratification bootstrap**, contract layer (data/event/API/telemetry standards), **Runtime/Storage SPI**, conformance harness v1, **U²ID auto-allocation on all core entities**, **cryptographic architecture floors** (§4.5), IaC baseline + Reference Pack v1. **Long-lead procurement launched in parallel from Month 1 (§13).**

**Gate:** a new entity type + behavior pack flows end-to-end via pure config (create → schema → generated API/UI → storage → search index), with zero code deploys; conformance harness admits a second storage engine.

### Phase 1 — Full-Platform Core Commerce (Months 7–24) — *the everything-day-1 build*
All §3 capability services built *as kernel applications*: catalog + **all Product Type Registry packs** (physical, digital+DRM, subscriptions, services/bookings, gift cards, kits, perishables, regulated, CPQ, freight, used/C2C, auctions, rentals, trade-in, group-buy, live/social, AR/3D, voice, charity, fractional, **health vertical pack**), search + per-language analyzers, cart/checkout + PSP adapters + **COD**, orders saga + bitemporal dispute reconstruction, **Monetization Stack** (billable-resource registry, metering/rating, commission engine, offers, entitlements, SaaS billing, FX settlement, FinOps), **U²D dictionary + aliases/merges**, Tax Engine v2 + e-invoicing adapters, Rules Engine, Geo, SEO platform, Experimentation platform, notifications, marketplace (3P offers + buy-box + KYC), Logistics v2 + unified commerce/POS + returns, support portal + decision-explainability, tenant/seller finance portal, onboarding/migration tooling, E2E sequences + golden scenarios + capacity model (§10–12) proven progressively.

**Gate:** all product types transactable; 1P + 3P + payouts + tenant billing + COD + subscriptions end-to-end; multi-vendor split payments reconciled daily; **no vertical required a code deploy beyond its config pack**.

### Phase 2 — Global Markets & Residency (Months 25–30)
Market Registry rule packs + adapter certification waves (every target market), regional data-residency cells, DSR APIs, multi-currency/locales, marketplace-facilitator tax registrations, sovereign-cloud RuntimeTargets, offline/low-connectivity mode, additional regional carriers/lockers, regional compliance packs (LGPD/DPDP/PDPA/SCA), app-store-style **app marketplace + developer ecosystem**.

**Gate:** N markets live where every market was onboarded config-only; regional residency verified by audit.

### Phase 3 — Agnosticism Proof & Scale (Months 31–33)
**Dual proof:** (a) a new market onboarded with zero code deploys; (b) the full stack deployed on a **second RuntimeTarget** (different cloud/on-prem) via conformance-admitted packs. Load tests to 250k orders/hr burst; flash-sale mode (virtual waiting room); active-active multi-region with region-pinned ledger + global settlement; chaos drills; reprojection/backfill of a full epoch migration at scale.

**Gate:** both proofs pass; SLOs hold at burst load; epoch migration zero-downtime verified.

### Phase 4 — AI Commerce, Ecosystem & Agentic (Months 34–36)
AI shopping assistant + visual search at scale, agentic commerce protocols (signed delegations, scoped spending), forecasting/ML pricing, seller-financing data products, marketplace ads auction optimization, native mobile apps (offline, push, deep-links, release ops), SOC 2 Type II + ISO 27001 audits complete, public API ecosystem GA.

**Gate:** agentic purchase completes end-to-end under constitutional policy; audits passed; ecosystem monetizing.

> Roadmap sync rule: any future requirement change must update this section in the same change (Living-Document Protocol).

## 8. Team Shape (for sizing)
1 **kernel team (~10 world-class platform engineers — the critical path)**, platform infra team, commerce squads (identity, catalog/search, checkout/payments, orders/fulfillment, marketplace, monetization), data/ML team, SRE team, security lead + AppSec + crypto engineering, product/design (portals + storefront component library), experimentation/FinOps, compliance/ops liaison, finance-ops (reconciliation exceptions), content/cold-start team (rule packs, translations, category schemas). **~90–120 at peak** (true-everything-day-1 consequence).

## 9. Top Risks & Mitigations
- **Oversells/payment inconsistency** → reservations, idempotency, sagas, daily ledger reconciliation
- **Noisy tenant blast radius** → RLS + **crypto-isolation** (§4.5), per-tenant quotas, cell-based architecture
- **PCI scope creep** → registry-DLP rejects card-data attributes at write time; PSP-hosted fields only — scope permanent by construction
- **Search/checkout coupling** → CQRS isolation, graceful degradation fallbacks
- **GDPR at event-sourced scale** → PII vault + crypto-shredding from day 1 (retrofitting is expensive)
- **Seller fraud** → KYC, rolling reserves, velocity limits, sanctions screening
- **EAV performance tax** → compiled projections per epoch + multi-level caches; raw-EAV-query linter ban on hot paths
- **Mutable-schema audit** → epoch + schema-version pinning on every transaction/journal entry; deterministic replay
- **Generality tax on velocity** → blessed codegen SDKs; kernel team owns contracts only
- **Registry as SPOF** → HA registry with local replicas; <15ms P99 read budget; cached context resolution
- **Config sprawl** → config CI + validation + simulation harness; tiered change control
- **Rating/metering correctness** → invoice-vs-ledger verification harness; financial invariant tests (§11)
- **Entitlement-check latency** → cached grants, short TTL, P99 < 5ms budget
- **Behavior-pack combinatorics** → generated contract-test matrix per pack combination
- **ID squatting/vanity abuse** → constitutional resolution policy + pricing; enumeration protection per scheme
- **Adapter matrix explosion** → conformance automation as the single admission gate
- **Contract drift** → compatibility linters; versioning-as-data with deprecation policy
- **Weak-config abuse (crypto/policy)** → constitutional floors + publish-time validation; auto-rollback on SLO breach
- **Crypto performance tax** → envelope encryption + hot-path key caching (budget in §5)
- **BYOK/HYOK ops complexity** → entitlement-gated + runbooks
- **True-everything-day-1 schedule risk** → procurement from Month 1; progressive gate verification; content cold-start as a first-class workstream (§13)

---

## 10. End-to-End Sequence Specifications & Failure-Path Operations

**Golden E2E path (every step needs event + contract definitions before build):**
tenant signup → config (markets, fees, types) → catalog import → shopper lands (market/geo negotiation) → search → PDP (context-resolved price/tax display) → cart → checkout (context resolution → tax → fraud screen → payment auth → inventory reserve → commission calc) → order saga → fulfillment (pick/pack/ship/track) → delivery → refund/return → payout → tenant billing → reconciliation. Each arrow = defined events, contracts, idempotency keys, and SLO budgets.

**Decision-Explainability Service:** per order line — "why was I charged this fee/tax/price" — rule-fire audit trail surfaced in support + tenant portals; powered by bitemporal rule-evaluation records.

**Failure-path operations (the real 1% complexity):**
- Stuck-saga dashboards + manual intervention tools for support (compensate, force-advance, force-refund — all audited, policy-scoped)
- DLQ handling with replay tooling; poison-message quarantine
- Compensation triggers: auto-refund on payment-capture failure, inventory release on abandonment, payout-hold on risk flags
- Reconciliation exceptions queue (finance-ops team): PSP settlement vs ledger, carrier invoices, COD cash
- Break-glass: time-boxed, audited, auto-expiring elevated access (§6)

## 11. Golden Scenarios & Financial Invariant Tests

- **Ledger invariants (tested continuously):** every journal entry sums to zero; no dangling accounts; payouts ≤ collected − reserves; commission = Σ fee-matrix evaluation at pinned epoch
- **Hand-computed golden cases:** multi-vendor split (3 sellers × 2 markets × COD + card), partial refund with fee pro-rating, cross-border-disabled verification, subscription renewal with dunning, marketplace-facilitator tax remittance
- **Bitemporal replay tests:** reconstruct any order's displayed price/tax/fee at transaction time; e-invoice correction flows
- **Behavior-pack matrix:** generated contract tests per pack combination (type × fulfillment × pricing × market pack)
- **Agnosticism proofs as tests:** golden suite runs identically on every admitted RuntimeTarget/Storage pack

## 12. Capacity Model Workbook (drives §5 SLOs → concrete sizing)

250k orders/hr burst → per-service partition/shard/connection sizing; context-resolver cache cluster sizing vs <5ms P95; U²ID allocation throughput; search index shard plan for 10M hot SKUs; ledger write throughput region-pinned; event-stream partitions per topic family; metering pipeline rating throughput; reprojection worker fleet for epoch migrations; CDN/cache hit-ratio targets per surface; failure-mode budgets per dependency (what degrades first, in what order — graceful-degradation ladder).

## 13. Long-Lead Business, Legal & Procurement (starts Month 1 — co-critical-path)

- **PSP platform agreements + money-transmission/payout licensing per market** (platform approvals, MSB registration, escrow law per state/country)
- **Vendor contracts + certifications:** every tax, carrier, KYC, e-invoicing, TMS adapter is a BD + certification project (2–6 months lead each)
- **Marketplace-facilitator tax registrations** in every activated state/country — legal-entity work
- **Reference-pack content cold-start (a first-class workstream):** tax rule packs per market, carrier integrations, translation-memory seeding, category attribute schemas — the platform ships empty; this content is real delivery
- DPA/ToS templates for tenants/sellers, insurance
- **Constitution v1 ratification bootstrap:** initial T-C quorum designated + ceremony executed at Phase 0 (chicken-and-egg resolved by charter signing)
- Budget envelope: ~$300–400M class program (peak ~90–120 people over 36 months + infra + content + legal)

## 14. Operational Readiness

Runbooks per service; finance-ops team for reconciliation exceptions (staffed from Phase 1); support training + tooling (decision-explainability, U²ID resolution); tenant/seller documentation + academies; game days + chaos drills; break-glass governance drills; status page + incident comms templates; capacity reviews per release; content cold-start ongoing ops.

## 15. Kernel Data Model v0 (first build artifact)

Registry/context/relationship schemas drafted as the first Phase-0 deliverable: entity-type definition grammar, attribute schema + classification, relationship edge types, context frame dimensions, behavior-pack binding format, epoch/manifest structure, U²ID scheme descriptor format, rule-pack format, config-inheritance resolution algorithm, codegen manifest — each with a worked example (a clothing-brand tenant derived end-to-end as pure data).

---

*Epoch 2 complete — open-ended. Next epoch upgrades assimilate here via the Living-Document Protocol: single doc, upgrade-only, roadmap synced, no final state.*
