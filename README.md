# Live Support Notes Analyzer

Parses Odoo Live Chat CSV exports, extracts `app`, `issue`, and `ticket_needed`
from the **Live Chat Note** field across all note formats, and exports three
structured CSV files for training prioritization and analysis.

---

## Quick start (local)

```bash
# 1. Install dependencies
npm install

# 2. Run dev server  →  http://localhost:5173
npm run dev
```

---

## Build for production

```bash
npm run build
# Output is in the /dist folder
```

---

## Deploy to Vercel (free)

### Option A — Vercel CLI (recommended)
```bash
npm install -g vercel
vercel        # follow the prompts, deploy in ~30 seconds
```

### Option B — Vercel dashboard (no CLI)
1. Push this folder to a GitHub repo
2. Go to https://vercel.com → "Add New Project"
3. Import the repo → click Deploy
4. Done — you get a URL like `https://support-analyzer-xxx.vercel.app`

### Option C — drag and drop
1. Run `npm run build`
2. Go to https://vercel.com/new
3. Drag the `/dist` folder onto the page

---

## Deploy to Netlify (alternative)

```bash
npm run build
# Then drag /dist onto https://app.netlify.com/drop
```

---

## CSV outputs

| File | Contents |
|------|----------|
| `*_detail.csv` | One row per structured conversation — `created_on`, `language`, `format`, `app`, `issue`, `ticket_needed`, `raw_note` |
| `*_summary.csv` | One row per `app × issue` combo, sorted by frequency — includes ticket escalation counts and `pct_escalated` |
| `*_unstructured.csv` | Free-text notes that couldn't be parsed — feed into BERTopic for topic modeling |

---

## Note formats supported

| Format | Example |
|--------|---------|
| New standard | `app: Invoicing  issue: Bank sync  ticket_needed: yes` |
| Old Spanish | `Módulo: Contabilidad  Problema: Error de conciliación  Ticket: Sí` |
| Old English | `Module: Accounting  Problem: Reconciliation error  Ticket: Yes` |
| Free text | Anything else → goes to `_unstructured.csv` |
# support-analyzer
