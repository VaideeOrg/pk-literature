# web

Customer-facing storefront: Next.js 15 App Router, deployed to AWS Lambda
via `@opennextjs/aws` behind its own CloudFront distribution at the bare
`domain_name` (`terraform/modules/cloudfront-web`). Talks to every other
service (`api-catalog`, `api-feed`, `api-search`, `api-commerce`,
`api-identity`) over the one shared API Gateway HTTP API — no direct DB
access, no server actions, everything goes through `src/lib/api/*`.

## Why every route is `dynamic = "force-dynamic"`

`app/layout.tsx` forces the whole app dynamic rather than letting
individual routes opt in. The shared header (`CartLink`/`AccountLink`)
reads the visitor's `anonymous_id`/auth cookies on every request — there
is no genuinely static route here — and Next's own build-time static-
generation pass turned out to be where a pnpm-workspace quirk actually
bites (see below), so skipping it sidesteps that entirely rather than
chasing it page-by-page.

## Two fetch layers, not one

`src/lib/api/server-fetch.ts` (Server Components, reads cookies via
`next/headers`, forwards them as a literal `Cookie:` header since Node's
`fetch` has no browser cookie jar) and `src/lib/api/client-fetch.ts`
(Client Components, `credentials: "include"`) both implement the same
`Fetcher` type (`src/lib/api/fetcher.ts`) so every function in
`catalog.ts`/`feed.ts`/`search.ts`/`commerce.ts`/`identity.ts` works with
either without duplicating request logic.

## Anonymous-ID cookie

`middleware.ts` provisions a non-`httpOnly` `anonymous_id` cookie on
first visit — deliberately readable by client JS (it's a correlation ID,
not a credential) — distinct from the `httpOnly` auth cookies
`apps/api-identity` sets. `COOKIE_DOMAIN` on that service scopes those
auth cookies to every subdomain of the deployed domain so this app's
server-side fetches actually receive them back; see
`apps/api-identity/src/auth/auth.controller.ts`.

## Known scope boundaries

- **Order history is anonymous-cart-scoped, not account-scoped.**
  `apps/api-commerce`'s `GET /orders` (built in Phase 6, before Identity
  existed) filters by `X-Anonymous-Id` only — there is no
  `customerId`-based query anywhere in its cart/checkout/orders code.
  `app/account/orders/page.tsx` still gates on login (redirects if
  unauthenticated, the right product behavior), but the list it shows is
  whatever's tied to *this browser's* anonymous-cart lineage, not a true
  cross-device account history. Fixing that for real means
  `apps/api-commerce` verifying the access-token JWT and querying by
  `commerce.orders.customerId` — real backend work, out of scope here.
- **Razorpay Checkout.js integration (`src/lib/razorpay.ts`) is
  unverified against a live account** — same disclosed limitation as
  `apps/api-commerce/src/payments/razorpay.client.ts`.
- **No ISR/static generation, no revalidation queue.** Every route is
  dynamic (see above); `terraform/modules/opennext` deliberately does
  not provision OpenNext's ISR/on-demand-revalidation Lambda+queue,
  since there's nothing here for it to revalidate. Revisit if a future
  phase adds a genuinely cacheable route.

## A real pnpm/Next.js bug, not a style choice

This workspace installs two React majors side by side — `apps/medusa`'s
admin dashboard needs 18.x, this app and `packages/ui` need 19.x. That
produced one confirmed, still-relevant failure, plus a second one that
looked related but wasn't.

**Typecheck**: `next`'s own `.d.ts` files (e.g.
`next/dist/styled-jsx/types/css.d.ts`) resolve a bare `import ... from
"react"` via plain ancestor-directory module resolution starting at
*next's own* install location, not this app's. That walk passes
through pnpm's shared `node_modules/.pnpm/node_modules` fallback slot
before ever reaching `apps/web/node_modules` — and that slot can only
hold one version of `@types/react`, which apps/medusa's much larger
dependency count wins. The result was next's own types pulling in
`@types/react@18.x`'s global JSX augmentation into this app's
compilation alongside the real `19.x` types, producing
`TS2786`/`ReactPortal` errors on every `forwardRef`-based `packages/ui`
component. Fixed with an explicit `paths` remap in `tsconfig.json`
(`"react"`/`"react-dom"` → this app's own `@types/react`/
`@types/react-dom`), which applies program-wide regardless of which
file does the importing.

**What looked like the same bug at runtime, but wasn't**: both `next
build`'s page-data collection for `/books/[id]` and the deployed
Lambda's first real request crashed — `createContext is not a
function` at build time, `Cannot read properties of null (reading
'useOptimistic')` at runtime. A webpack `resolve.alias` forcing
`react`/`react-dom` to this app's own `node_modules` copy was tried
first, by analogy with the typecheck fix above, and made no measurable
difference to either error under any variation (alias target format,
`isServer` gating, disabling `resolve.symlinks`) — which in hindsight
ruled out the phantom-slot theory for this case: `pnpm --filter web why
react` showed exactly one `react` resolution (`19.0.0`) across this
app's entire dependency graph the whole time.

The real cause: `packages/ui/src/components/button.tsx` imports
`@radix-ui/react-slot`'s `Slot`, which calls `React.createContext` at
module scope — a Client-Component-only API — but the file had no
`"use client"` directive. Without it, the App Router treats the module
as part of the Server Component graph; page-data collection evaluates
it under Next's restricted server React condition (no `createContext`
there), and the deployed bundle ends up with a copy of the module
disconnected from the dispatcher next-server actually drives at
runtime (no `useOptimistic` there either). Adding `"use client"` to
`button.tsx` fixed both failures with no webpack config needed at all
— `next.config.ts` carries no React-related `webpack()` override.

`packages/ui`'s `peerDependencies.react` is also now pinned to the
exact `19.0.0` (not `^19.0.0`) apps/web installs, closing off a
separate, real duplicate-instance possibility surfaced while debugging
this (`@radix-ui/react-slot` resolving its own `react` peer to whatever
`^19.0.0` meant at lockfile-generation time, independently of this
app's pinned version) — confirmed harmless to the actual crash above,
but worth keeping closed.

## Deploying

`scripts/package-opennext.sh` builds `dist-server-lambda.zip` and
`dist-image-lambda.zip` — the two artifacts
`terraform/modules/opennext`'s Lambdas reference. Not handled by that
script or by Terraform:

- **Static assets** (`.open-next/assets`, served at `/_next/static/*`
  from `terraform/modules/opennext`'s S3 bucket) and the **CloudFront
  invalidation** after every deploy are both handled by
  `.github/workflows/terraform-apply.yml`, right after `terraform
  apply` — an `aws s3 sync` (content-hashed `_next/static/*` gets a
  year-long immutable cache; everything else revalidates on every
  request) followed by `aws cloudfront create-invalidation
  --paths "/*"`. Terraform doesn't model bulk object uploads well, so
  this lives in CI rather than in either module.
- **`NEXT_PUBLIC_*` env vars** (`NEXT_PUBLIC_API_BASE_URL`,
  `NEXT_PUBLIC_CDN_HOST`, `NEXT_PUBLIC_RAZORPAY_KEY_ID`) are inlined
  into the client JS bundle at `next build` time by Next.js itself —
  they have to be exported as shell env vars in whatever CI step runs
  `package-opennext.sh`, setting them as this Lambda's runtime
  environment (which `terraform/environments/*/web.tf` does for the
  plain, server-only `API_BASE_URL`) does nothing for them. Still an
  open gap — `terraform-apply.yml`'s build step doesn't set these yet.
- The image-optimization Lambda is deployed with `architectures =
  ["arm64"]` — `@opennextjs/aws` installs `sharp`'s arm64 prebuilt
  binary for that function specifically, confirmed by actually running
  `open-next build` in this sandbox (its `npm install --arch=arm64`
  step is unconditional, not host-architecture-dependent). That native
  binary install itself needs to download from `github.com` at build
  time — blocked by this sandbox's network policy, so the image
  Lambda zip produced *in this environment* is missing `sharp` and
  isn't actually deployable as built here. Not a code or config
  problem — a normal CI runner with unrestricted outbound HTTPS
  doesn't hit this.
