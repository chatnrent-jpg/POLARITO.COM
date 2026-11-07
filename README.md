# Polarito

Next.js polarity transmission dashboard (Alpaca daily bars). Local / Node hosting uses a login gate; Name.com static export still uses the PHP bars bridge.

## Getting Started

```bash
cp .env.example .env.local
# Fill Alpaca keys + Polarito login env (see below), then:
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Unauthenticated visitors are redirected to `/login`.

## Login gate (local / Node / Vercel)

The app is closed until someone signs in. Credentials live in **server env only** (never `NEXT_PUBLIC_*`, never a default password in the repo):

| Variable | Purpose |
| --- | --- |
| `POLARITO_AUTH_USER` | Username |
| `POLARITO_AUTH_PASSWORD` | Password (choose a strong one yourself) |
| `POLARITO_AUTH_SECRET` | Cookie signing secret (`openssl rand -hex 32`, ≥16 chars) |

Fail-closed: if any of the three are missing, sign-in is refused and the dashboard stays locked.

After a successful login, `src/components/PageRefresher.tsx` full-reloads the home page every **5 seconds**. Sign out clears the httpOnly `polarito_session` cookie.

This gate runs in `src/proxy.ts` for `next dev` / `next start` / Node hosts. The Name.com static HTML export has no Node runtime; protect that host separately (or run Node) if you need the same gate there.

## Scripts

- `npm run test` — unit tests (including session auth)
- `npm run build` / `npm start` — production Node app
- `npm run package:namecom` — static `/out` + PHP bars bridge

## Learn More

- [Next.js Documentation](https://nextjs.org/docs)
