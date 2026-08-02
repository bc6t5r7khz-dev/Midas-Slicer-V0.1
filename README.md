# QuickBar3D v67

A local-first Three.js application for inspecting MIDAS Civil MCT models,
defining local coordinates and volumes, slicing solid geometry, and laying out
reinforcement.

MCT files and saved workspaces remain in the browser. The application does not
upload model data to a backend.

## Prerequisites

- Node.js `>=22.13.0`

## Local development

```bash
npm ci
npm run dev
```

## GitHub Pages

This repository includes a separate static build and an automatic GitHub Pages
workflow.

1. Create an empty GitHub repository.
2. Push this repository to its `main` branch.
3. Open **Settings → Pages** in GitHub.
4. Under **Build and deployment**, choose **GitHub Actions** as the source.
5. Open the **Actions** tab and wait for **Deploy MCT Section Lab to Pages** to
   finish.

The application will be available at:

```text
https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/
```

Every later push to `main` republishes the site automatically. The static build
uses relative asset URLs, so no repository name needs to be configured.

To verify the Pages build locally:

```bash
npm run build:pages
```

The output is written to `pages-dist/`.

## Other commands

- `npm run dev`: existing Vinext development server
- `npm run dev:pages`: static GitHub Pages development server
- `npm run build`: existing hosted Vinext build
- `npm run build:pages`: static GitHub Pages build
- `npm test`: project test suite
