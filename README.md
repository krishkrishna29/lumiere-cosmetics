# Lumière cosmetics storefront

Responsive React/Vite demo for a modern cosmetics business. It includes a customer storefront, product browsing by category, cart drawer, newsletter signup surface, and a separate admin preview with overview metrics, revenue chart, recent orders, top products, inventory alerts, and navigation placeholders for catalog, customers, promotions, analytics, shipping, and settings.

The storefront currency is configured for India (INR / ₹). Product amounts are stored as paise in the backend.

## Run locally

```bash
npm install
npm run dev:full
```

The storefront runs on `http://127.0.0.1:5173` and the API runs on `http://127.0.0.1:4000`. Open `/admin` to reach the protected dashboard. Demo owner credentials are `admin@lumiere.test` / `ChangeMe123!`; change them through environment variables before sharing the app.

Run the services separately when preferred:

```bash
npm run server
npm run dev
```

Production build:

```bash
npm run build
```

## Production handoff

The app now includes a local Express + SQLite backend with JWT authentication, password hashing, seeded products, and role-protected admin endpoints. It also supports Firebase Firestore through the Firebase Admin SDK. When the four `FIREBASE_*` variables are configured, users and product writes are mirrored to Firestore collections (`users`, `products`) and the API exposes `/api/storage` to confirm the active provider. Without them, the app safely uses SQLite.

To enable Firebase:

1. Create a Firebase project and enable Firestore in production mode.
2. Create a service account under Project settings → Service accounts and generate a private key. Give it the **Cloud Datastore User** role.
3. In Render, add the entire downloaded JSON as the secret `FIREBASE_SERVICE_ACCOUNT_JSON`. Alternatively, use the individual service-account fields in `.env.example`.
4. Restart `npm run server` and verify `http://127.0.0.1:4000/api/storage` returns `{"enabled":true,"provider":"firestore"}`.

If service-account key creation is blocked by organization policy, a Google Cloud Organization Policy Administrator must permit service-account keys for this project or provide a supported workload-identity configuration. Application Default Credentials from a local computer do not transfer to Render.

Before launch:

- Replace the local SQLite file with your managed production database if needed, and add migrations/backups.
- Keep server-side authentication and role checks enabled; the frontend login gate is only a client convenience, while API authorization is enforced in `server/server.js`.
- Add CSRF protection if switching to cookie-based auth, rate limiting, audit logging, password reset, MFA, and account lockout before launch.
- Connect a payment provider and move checkout creation/verification to the server.
- Connect shipping rates, labels, tracking, tax, email, returns/refunds, and coupon validation to trusted server endpoints.
- Store credentials only in deployment secrets. See `.env.example` for the intended integration placeholders.
- Add image hosting/CDN, error monitoring, analytics consent, legal pages, and transactional email before release.
