# website

The stim-cli documentation site, built with [Docusaurus](https://docusaurus.io/).

```bash
npm install
npm start        # local dev server
npm run build    # static site into build/
```

Deployed to GitHub Pages by `.github/workflows/docs.yml` on every push to
`main` that touches `website/`. The doc pages under `docs/` were seeded from
the package READMEs and `docs/getting-started.md` at the repo root; when those
change, keep the corresponding page here in sync.
