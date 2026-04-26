# LechPlay Webshare

Čistá verzia bez Sosáč/Streamuj. Frontend je statický pre GitHub Pages, backend je Cloudflare Worker.

## Súbory

- `index.html` – vizuál a player
- `worker.js` – Webshare API backend
- `manifest.json` – PWA manifest
- `icon.svg`, `icon-192.svg` – ikony

## Cloudflare Worker

1. Vytvor nový Worker.
2. Vlož obsah `worker.js`.
3. Nastav secrets:

```bash
wrangler secret put WEBSHARE_USERNAME
wrangler secret put WEBSHARE_PASSWORD
```

Voliteľne nastav premennú:

```txt
ALLOWED_ORIGIN=https://tvoj-github.github.io
```

## GitHub Pages

1. Nahraj `index.html`, `manifest.json`, `icon.svg`, `icon-192.svg`.
2. V `index.html` zmeň:

```js
const API_BASE = "https://TVOJ-WORKER.workers.dev";
```

na URL tvojho Workeru.

## Testy

- `https://TVOJ-WORKER.workers.dev/api/status`
- `https://TVOJ-WORKER.workers.dev/api/search?q=test`

## Poznámka

Používaj iba pre vlastné alebo legálne dostupné súbory. Frontend nikdy nedostane tvoje prihlasovacie údaje; login prebieha iba vo Workeri.
