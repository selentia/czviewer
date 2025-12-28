# CZ MultiViewer Extension

**Chrome extension for watching multiple CHZZK live streams on a single screen.**

> [!NOTE]
> This repository contains **only the Chrome Extension source code** for CZ MultiViewer.  
> Web services, backend APIs, and deployment infrastructure are intentionally excluded.

📄 **Other languages**
- [🇰🇷 한국어 문서](./docs/README.KO.md)

---

## Overview

CZ MultiViewer is a Chrome extension that enhances the CHZZK viewing experience by enabling  
multi-stream layouts and additional viewing utilities directly in the browser.

It is designed to be lightweight, client-side only, and compliant with Chrome Extension MV3.

---

## Features

- View multiple CHZZK live streams simultaneously
- Seamless integration with the CZ MultiViewer web page
- Stream latency display between channels
- CHZZK login–based chat features (via extension)
- Clean and minimal popup UI

---

## Scope of This Repository

This repository includes:

- Chrome Extension (Manifest V3) source code
- Background / Content scripts
- Popup UI
- Extension-related static assets (icons, popup images)

This repository **does NOT include**:

- Web application source code
- Backend or API servers
- Obfuscation or production deployment scripts

> The separation is intentional to keep this repository focused on the extension itself.

---

## Project Structure

```text
.
├─ src/
│  ├─ background/    # Background scripts
│  ├─ content/       # Content scripts
│  ├─ popup/         # Extension popup UI
│  ├─ shared/        # Shared utilities and message definitions
│  └─ types/         # TypeScript types
├─ public/           # Extension assets (icons, popup images)
├─ manifest.json
├─ rules.json
├─ tsconfig.json
├─ tsup.config.ts
└─ package.json
```

---

## Build

This repository uses **tsup** for bundling.

```bash
npm install
npm run build
```

The build output will be generated in:

```text
dist/extension/
```

> [!NOTE]
> Build artifacts are not committed to the repository.

---

## Installation

You can install the published extension directly from the Chrome Web Store:

👉 **Chrome Web Store**  
https://chromewebstore.google.com/detail/cz-multiviewer/lnpfojaeffcahabkhdahkhcnpbgkigai

---

## Development Notes

- This is a **client-side only** Chrome extension
- No external servers are required for basic functionality
- ESLint and Prettier are included for code consistency (editor-level usage)

---

## License

MIT License  
© selentia

> [!NOTE]
> Some UI assets (e.g. service logos) are subject to their respective brand licenses.  
> See `public/NOTICE.md` for details.
