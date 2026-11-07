# Poortjie Info

Poortjie Info connects the community with local businesses, services, marketplace listings, transport information and LaynRider web booking.

This repository intentionally contains the public website source.

- Website: [poortjie.info](https://poortjie.info/)
- Built by: [Digilayn](https://digilayn.co.za/)

## Technology

Static HTML, CSS and JavaScript, with Tailwind CSS, Firebase-backed functionality and Google Maps. Explicit local/live builds select the Firebase service target. Account, management and booking features require the appropriate authentication and server permissions.

## Structure

- `index.html`: redirects visitors to the home page.
- `home.html`: community home page and local business discovery.
- `market.html`: marketplace.
- `services/`: service categories, business and marketplace forms, and ratings.
- `authentication/`: sign-in, registration and profile pages.
- `manage/`: authenticated content-management pages.
- `laynfleet/`: LaynRider web booking and Android app download information.
- `chats.html` and `support.html`: community chat and support information.
- `scripts/` and `styles/`: shared browser code and styles.
- `favicon/`: public icons and web app manifest.
- `tests/` and `laynfleet/laynrider/tests/`: source tests.

## Local Preview

Double-click `launch-local.command` in Finder to rebuild and verify the local
build, serve it at http://127.0.0.1:8102/ and open your browser. Python 3 is
required. Keep its Terminal window open; Control-C stops the website server.
Start the Backend Firebase Emulator Suite separately. The launcher never serves
the live build; an unavailable emulator remains an error.

Alternatively, from the repository root, generate and serve the local output:

```sh
python3 tools/build-site.py local
python3 -m http.server 8000 --bind 127.0.0.1 --directory dist/local
```

Open [localhost:8000/home.html](http://127.0.0.1:8000/home.html). Serve this output
as the document root when configuring IntelliJ local preview, or open the generated
`dist/local/index.html` in IntelliJ. No URL environment parameter is needed. Local
builds retain `.html` URLs, resolve internal navigation to existing files, and preserve
IntelliJ project-path prefixes. Live builds keep the original clean URLs.

The local build connects available Auth, Firestore, Storage and Functions SDKs to
`127.0.0.1` ports 9099, 8080, 9199 and 5001 respectively, in Firebase project
`digilayn-projects`. Start the suite from the canonical `Backend` repository;
this website does not own a separate Functions implementation.

Run `python3 tools/build-site.py live` to prepare `dist/live` for later publication.
Source files explicitly select live services. Hostname, IntelliJ, Android emulator
presence and fleet prod/dev selection never decide the service target.

Local RTDB access and legacy Rider API requests fail explicitly because those local
services are not configured. They never contact live services as a fallback.
Normal login, registration, profile, suspension and shared-account checks retain
existing behavior, using the selected target's services. Missing local data or
functions remain real failures; no account data or backend functions are fabricated.

These are local source/build changes. Login/register/profile behavior still needs
owner validation; no account, emulator process, rule or hosting changes are implied.

## Shared Theme

Both websites use the canonical Material colour palette from `Notes/Theme/css/` in the development workspace. Pages use semantic `--digilayn-*` CSS variables and `digilayn-*` Tailwind colours rather than defining their own palette.

The shared generator in [Digilayn's website repository](https://github.com/usrmusa/digilayn-web-main/tree/main/theme-source) creates these local assets for both sites:

- `styles/digilayn-theme.css`
- `scripts/theme.js`
- `scripts/digilayn-tailwind.js`
- Theme and background colours in `favicon/site.webmanifest`

With the canonical palette available in the workspace, run these commands from the Digilayn repository:

```sh
python3 theme-source/generate-theme.py
python3 theme-source/generate-theme.py --check
```

The check detects generated-asset drift and colour definitions introduced outside the shared theme. Generated assets are committed, so a standalone checkout can serve the site without the Notes workspace or generation step. Do not edit generated assets independently. Light, dark and contrast palettes are included. Provider artwork, such as the Google sign-in logo, retains its own colours.

## GitHub Pages

For branch-based publishing, use `main` at the repository root. `CNAME` declares `poortjie.info` as the custom domain. The root `.nojekyll` file tells GitHub Pages to publish the static files without Jekyll processing.

See [GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site) for publishing configuration. Firebase tooling files in this checkout do not establish which hosting service is currently serving the domain.

## Public Repository Boundary

This repository is public intentionally. Keep credentials, service-account keys, access tokens, private account records, local environment files and editor metadata out of it. Backend functions and authoritative Firebase rules are maintained separately; do not deploy backend or rule changes from this website checkout.

Firebase browser configuration identifies the project for client SDKs and is included deliberately. It does not grant administrative access; backend services and Firebase rules must enforce authorization. See [Firebase API key guidance](https://firebase.google.com/docs/projects/api-keys).

## Shared Profile And Username Output

Poortjie and Android now use the same shared `users/{uid}` field names: `displayName`,
`phone`, `bio`, `photoUrl`, `username`, with Auth email and the original `createdAt`.
Names normalize to title case with 1–3 words; saved phone numbers contain ten digits;
bio text retains its entered whitespace and is limited to 128 characters. Optional
fields are not invented from email prefixes. Google identity only seeds actual
provider email/name/photo where the saved field is missing or empty.

Usernames reserve `usernames/{name}` atomically with the profile, using `ownerId`
(current owner uid, or null when free) and `ownedAt`. Ownership history is audit-only
under `usernames/{name}/history/{uid}/periods/{id}` with `ownedAt`/`endedAt`.
Claiming is allowed only when the reservation is unowned or already owned by the same
uid. Changing or clearing releases the old name immediately for anyone to claim.
The canonical schema is documented in the Backend README.

Profile photos are uploaded under `users/{uid}/profile/{timestamp}.jpg` and their
URL is saved before reporting success. Poortjie-only role settings are preserved.
Local manifest links include same-origin credentials for IntelliJ's protected
resource server. Existing live routes remain unchanged.

These source changes and emulator tests do not establish successful Android Studio
builds or browser registration/profile behavior; owner verification remains pending.

For Android Studio Play actions, use the scripts in
`Apps/LaynFleet/local-dev/` in the Digilayn workspace. Console actions select a
page via `tools/launch-local.py --page <relative-html-path>` and can reuse an
already-running server after verifying its local build configuration.
