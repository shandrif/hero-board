# Hero Board — setup

## 1. Database (one time)
Supabase → project **hm-fieldnote** → SQL Editor → New query → paste all of `supabase-setup.sql` → Run.
It only adds Hero Board tables (names start with `hb_`). Trackit is not touched.

## 2. Put the site online (GitHub Pages, free)
1. On GitHub, create a new public repository called `hero-board`.
2. Upload these files: `index.html`, `admin.html`, `staff.html`, `style.css`, `common.js`, `config.js`.
3. Repository → Settings → Pages → Source: "Deploy from a branch" → Branch: `main`, folder `/ (root)` → Save.
4. After a minute your site is at `https://shandrif.github.io/hero-board/`.

## 3. Pages
| Page | Who | Address |
|---|---|---|
| Sign in (everyone) | You and store managers | `…/hero-board/` — Store ID for stores, your email for admin |

| Staff | Staff (opened from the WhatsApp link) | made automatically |

## 4. Weekly routine
1. Admin → **Hero Weeks** → New hero week → add products (or upload the product template) → **Publish**.
2. Store managers see it instantly → tap **I acknowledge** → **Share on WhatsApp** to their staff group.
3. Staff open the link → enter name + Employee ID → **I'm aware**.
4. Admin → **Dashboard** to watch progress live. **Copy for WhatsApp** gives you a ready follow-up list.

## First-time store setup
Admin → **Stores** → Download store template → fill in store names → Upload.
Each store gets a Store ID (HM001, HM002…) and a password. Click **Download all logins** to share them.
