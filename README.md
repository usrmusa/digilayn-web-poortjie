# Poortjie Info

Poortjie Info connects the community with local businesses, services, marketplace listings, transport information and LaynRider web booking.

This repository intentionally contains the public website source.

- Website: [poortjie.info](https://poortjie.info/)
- Built by: [Digilayn](https://digilayn.co.za/)

## Technology

Static HTML, CSS and JavaScript, with Tailwind CSS, Firebase-backed functionality and Google Maps. There is no application build step. Account, management and booking features require the appropriate authentication and server permissions.

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

From the repository root, run:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [localhost:8000/home.html](http://127.0.0.1:8000/home.html). Use explicit `.html` paths with this simple server; it does not reproduce GitHub Pages extensionless URL handling. The site may normalise the displayed URL after loading. Previewing does not provide a separate Firebase test environment.

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
