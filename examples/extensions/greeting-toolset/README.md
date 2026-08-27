# Greeting Tool Set example

A complete external extension consumer. It imports only `@nox/extension-api`,
registers one authority and one configurable tool-set type, and leaves instance
creation to Nox configuration.

Build it with the Extension API installed as a development dependency:

```sh
bun install
bun run build
```

Copy this directory (including `nox-extension.json` and `dist/extension.js`) into
`EXTENSIONS_DIR`. Then create a `toolSets` entry whose `type` is `greeting` and
grant that configured instance from a blueprint.

`@nox/extension-api` remains external in the bundle. Nox supplies the compatible
runtime selected by `engines.extensionApi`.
