# Category Prerender (added to existing PDP App Builder app)

Category (PLP) prerendering was merged into this existing PDP prerender repo (`echidna/prerender`) beside the production PDP flow. Use the **same** App Builder project, overlay, and Admin API token you already configured for products.

## What mirrors production

| PDP (existing) | Category (added) |
|---|---|
| `fetch-all-products` | `fetch-all-categories` |
| `check-product-changes` | `check-category-changes` |
| `mark-up-clean-up` | `mark-up-category-clean-up` |
| `pdp-renderer` | `plp-renderer` |
| `/public/pdps/products/...` | `/public/pdps/categories/...` |
| product alarm triggers | category alarm triggers |

**Important:** category markup is stored under the **same BYOM overlay root** as PDPs (`/public/pdps`).  
That means your existing production overlay URL from `get-overlay-url` keeps working:

```text
https://...-public/public/pdps
  ├── products/{urlKey}/{sku}.html
  └── categories/{urlPath}.html
```

EDS request `/categories/gear` → overlay fetch `.../public/pdps/categories/gear.html`.

## Prerequisites (same as PDP)

1. Adobe App Builder project + downloaded credentials JSON  
2. `aio` CLI installed  
3. Helix org admin token from [admin.hlx.page](https://admin.hlx.page/)  
4. Site on **Helix 5 / Configuration Service** with BYOM overlay enabled  
5. Authored template page: `/categories/default` (optional but recommended)  
6. Storefront `config.json` reachable (prerender reads Commerce endpoint/headers from site config)

## Setup (production wizard path)

```bash
cd /home/krishnacv/Developer/echidna/prerender
npm install
npm run setup
```

Follow the Adobe setup wizard (same as PDP). After `.env` exists, add category variables:

```bash
CATEGORY_PAGE_URL_FORMAT=/categories/{urlPath}
CATEGORIES_TEMPLATE=https://main--ac-b2b--krishnacv23.aem.live/categories/default
ROOT_CATEGORY_ID=2
CATEGORY_DEPTH=4
```

Also ensure storefront PLP path extraction is deployed (`blocks/product-list-page/product-list-page.js`).

## Deploy

```bash
npm run deploy
```

### Publish the categories index (`published-categories-index.json`)

`/published-categories-index.json` 404s until the site content `query.yaml` includes
`index-published-categories` from this repo’s `query.yaml`.

With a Helix org admin token:

```bash
cd /home/krishnacv/Developer/echidna/prerender

# Merge carefully with the live query.yaml if you customized product includes.
# For a first-time add, POST this repo's query.yaml (contains products + categories):
curl -X POST \
  "https://admin.hlx.page/config/${ORG}/sites/${SITE}/content/query.yaml" \
  -H "content-type: text/yaml" \
  -H "x-auth-token: ${AEM_ADMIN_API_AUTH_TOKEN}" \
  --data-binary @query.yaml
```

Then force category HTML refresh (needed for `<meta name="urlpath">` used by the index):

```bash
aio rt action invoke aem-commerce-ssg/check-category-changes --result
```

Wait for EDS indexing, then open:

`https://main--ac-b2b--krishnacv23.aem.live/published-categories-index.json`

## Manual invoke (catch errors before enabling schedules)

```bash
# 1) Discover categories from Catalog Service
aio rt action invoke aem-commerce-ssg/fetch-all-categories --result

# 2) Render + preview/publish changed category pages
aio rt action invoke aem-commerce-ssg/check-category-changes --result

# 3) Cleanup deleted categories
aio rt action invoke aem-commerce-ssg/mark-up-category-clean-up --result
```

Local runners (require App Builder runtime auth in `.env`):

```bash
node runners/run-fetch-all-categories.js
node runners/run-check-category-changes.js
node runners/run-mark-up-category-clean-up.js
```

## Enable scheduled jobs

After manual invokes succeed, uncomment **both** product and category triggers/rules in `app.config.yaml`, then redeploy:

| Trigger | Interval | Action |
|---|---|---|
| `categoryScraperTrigger` | 60 min | `fetch-all-categories` |
| `categoryPollerTrigger` | 10 min | `check-category-changes` |
| `categoryMarkUpCleanUpTrigger` | 60 min | `mark-up-category-clean-up` |

## Overlay setup checklist

1. Invoke `get-overlay-url` and confirm overlay base ends with `/public/pdps`
2. Ensure site config overlay is:

```json
"overlay": {
  "url": "https://<namespace>-public/public/pdps",
  "type": "markup",
  "suffix": ".html"
}
```

3. Preview/publish a sample path:

```bash
curl -X POST \
  "https://admin.hlx.page/preview/<ORG>/<SITE>/main/categories/gear" \
  -H "authorization: token <AEM_ADMIN_API_AUTH_TOKEN>"
```

4. Verify View Source on live URL contains category `<title>`, canonical, JSON-LD, and PLP block.

## Failure modes this path is designed to surface

- Missing/expired `AEM_ADMIN_API_AUTH_TOKEN`
- Site not on Configuration Service (overlay rejected)
- Overlay URL pointing at wrong storage root
- Catalog Service header/config mismatches (`config.json`)
- Template `/categories/default` missing or unauthorized (`SITE_TOKEN`)
- Admin API 409/429 under large publish batches
- Deleted categories still returning 200 (cleanup not running)
- Nested L4 `urlPath` mismatches vs storefront PLP filter

## Relationship to storefront

This App Builder package (`echidna/prerender`) is the production-like prerender stack for PDP + category automation.

Storefront PLP URL handling lives in `ac-b2b/blocks/product-list-page/product-list-page.js`.
