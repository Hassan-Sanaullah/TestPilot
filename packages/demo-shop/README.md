# ShopMax — complex evaluation target

A deliberately complex e-commerce application used to demonstrate and evaluate TestPilot.
Express, server-rendered, in-memory state, no database.

```
npm run dev:shop          # http://localhost:4100
```

- Customer account: `test@example.com` / `Password123!`
- Admin account: `admin@example.com` / `Admin123!`
- `POST /__reset` restores all seed data — set it as the project's **Reset URL** in TestPilot so
  every run starts clean.

## Why it is complex

It exists to exercise the things that break naive browser agents. Each row is a real obstacle a
tester must get past:

| Feature | What it forces the agent to handle |
|---|---|
| **Cookie consent overlay** | A full-screen blocker on first visit — must be dismissed before anything else |
| **120 products**, 12 per page | Content far below the fold; pagination; "Load more" lazy loading via fetch |
| **Search + category + sort + max price** | Multi-field forms and `<select>` handling |
| **Hover mega-menu** ("Categories ▾") | Only opens on hover — a click alone never reveals the links |
| **Quick-view modals** | Overlay that intercepts clicks; closes with a button or Escape |
| **Shadow-DOM `<product-rating>`** | An open shadow root — invisible to any agent that only walks the light DOM |
| **Reviews in an `<iframe>`** | Cross-document traversal |
| **`confirm()` on cart removal** | A native JS dialog that blocks automation until answered |
| **3-step checkout wizard** | Per-step validation and state carried across pages |
| **Debounced async email check** | ~450 ms debounce + 350 ms server latency — must wait before asserting |
| **Toast notifications** | Appear and auto-dismiss after 3.5 s |
| **`target="_blank"` help link** | Opens a second tab |
| **Login-gated admin area** | Redirect-to-login, role check (403 for customers) |
| **Admin data grid** | Sortable columns, status filter, pagination, select-all, bulk delete behind `confirm()` |

## Seeded bugs (ground truth for evaluation)

| # | Where | Buggy behaviour | Correct behaviour |
|---|---|---|---|
| 1 | Cart → coupon `SAVE10` | Applies **20 %** | The label says "10% off", so 10 % |
| 2 | Product search | Case-**sensitive**: `laptop` finds nothing | Should match `Laptop Pro …` |
| 3 | Catalogue pagination | Page links **drop the category filter**, so page 2 shows all categories | The filter should persist across pages |
| 4 | Admin → sort by Total | Sorted as **text**, so `$9.99` comes after `$1020.40` | Numeric ordering |
| 5 | Registration | A password shorter than 8 characters is **accepted if it contains a digit** (`Ab1`) | Always require 8+ characters |

Everything else behaves correctly, so a passing test is a true negative and a test that fails on
one of the five above is a true positive. This gives a measurable ground truth for the project's
central claim: *do gap-generated tests find bugs that the hand-written suite missed?*

## Suggested requirements checklist

Paste into a TestPilot project (Requirements → Add):

```
R1  Users can register with a name, a valid email and a password of at least 8 characters
R2  Registration rejects an email that is already registered
R3  Registration rejects a password shorter than 8 characters
R4  The registration form reports whether an email is available before submission
R5  Users can log in with valid credentials and see a welcome message
R6  Login with a wrong password shows "Invalid email or password."
R7  Searching for a product name lists the matching products regardless of letter case
R8  Filtering by category shows only products in that category, including on later pages
R9  Sorting by price orders the catalogue from low to high
R10 Adding a product to the cart shows it in the cart with the correct line total
R11 Changing the quantity in the cart updates the line total and the order total
R12 Removing an item asks for confirmation and then removes it
R13 Applying coupon SAVE10 reduces the subtotal by 10 %
R14 An invalid coupon code shows an error and does not change the total
R15 Checkout requires the user to be logged in
R16 Checkout collects shipping details and rejects an incomplete address
R17 Placing an order shows an order confirmation and empties the cart
R18 Only administrators can open the admin area
R19 The admin order list can be filtered by status
R20 The admin order list can be sorted by total in ascending numeric order
```

## Test fixtures (not features)

Two routes exist only so TestPilot can test itself. They are not part of the
shop that the seeded-bug evaluation measures, and no requirement covers them.

| Route | Why it exists |
|---|---|
| `GET /slow` | Renders a page whose "Late button" is inserted 1.5 s after load. Replay must wait for a late element instead of calling it missing. |
| `GET /help` | Linked from the footer with `target="_blank"`, so a test can genuinely open a second tab. |

`POST /__reset` and `GET /__health` are the usual test hooks.
