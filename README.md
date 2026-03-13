# Split

Receipt splitting web app (React + TypeScript + Vite + Tailwind + shadcn-style UI primitives).

## MVP implemented

- Upload receipt image
- Interactive corner dragging to crop the receipt area
- Perspective flattening (homography warp) to "scan" the receipt
- Image adjustments: brightness, contrast, saturation
- OCR extraction with `tesseract.js` + preprocessing (upscale + binarization) for better mobile receipts
- Parsed editable receipt items (name, quantity, price)
- People list with default names + rename + add person
- Allocation table with **float quantities per person per item**
- Tip (percent or fixed amount)
- Final split totals per person

## Stack

- React + TypeScript + Vite
- TailwindCSS
- shadcn-style local UI components (`src/components/ui/*`)
- Tesseract.js for OCR

## Run locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
npm run preview
```

## CI

- Pull request workflow (`.github/workflows/ci.yml`) runs:
  - `npm ci`
  - `npm run lint`
  - `npm run build`

## Deploy (GitHub Pages)

A workflow is included at `.github/workflows/deploy-pages.yml`.

### One-time repo settings

1. GitHub → **Settings** → **Pages**
2. Source: **GitHub Actions**
3. (Optional) set custom domain to `split.goncaloraposo.com`

## Notes / next improvements

- Improve OCR parser with locale-aware currency detection and line-item confidence scoring
- Add manual rotate + auto edge detection
- Persist sessions in localStorage
- Add shared link / export summary
- Add unit tests for split math + parser
