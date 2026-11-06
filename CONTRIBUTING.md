# Contributing to IP-KVM

## Development

```bash
npm run build      # build into dist/
npm run test       # run this plugin's tests
npm run typecheck  # type-check this plugin
npm run validate   # check manifest.json
npm run migrations # write migrations after changing src/backend/tables.ts
npm run pack       # pack dist/ into a .tmxplug
npm run format     # format the code with Prettier
```

## Adding a KVM type

A KVM type is one file in `src/backend/drivers/` that implements `Driver` from `types.ts`, added to `drivers/index.ts`. It lists the login it needs, what it can do (`features`, `powerActions`) and reads the KVM with `read`. Web APIs go through `send` in `http.ts`, which only allows the KVM's own address. WebSockets go through `io.connect` and video through `openMjpeg`, so tests can fake them.

## Docs

The docs for this plugin are in [docs/](docs/), and `docs` in `manifest.json` links to them. Settings, permissions, services, environment variables and the API reference are made from `manifest.json` and the `@openapi` comments in the code, so keep those up to date instead of writing them by hand. See [writing docs](https://docs.termix.site/develop/docs).
