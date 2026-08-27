# `@nox/extension-api`

Stable contracts and host-provided runtime primitives for Nox extensions.

Extensions should depend on this package for development and keep it external in
their production bundle. Nox supplies the compatible runtime selected by the
`engines.extensionApi` range in `nox-extension.json`.

```ts
import { defineExtension } from '@nox/extension-api';

export default defineExtension({
  activate(context) {
    context.logger.info({}, `Activated ${context.extension.id}.`);
  },
});
```

The package is dependency-inverted and does not import Nox kernel modules.
Extension identity comes from `nox-extension.json`, not from module exports.

Each activation context also receives `context.storage`, an extension-scoped,
durable JSON document store. Transactions are atomic and synchronous:

```ts
await context.storage.transact((state) => {
  state.set('preferences', 'greeting', { salutation: 'Hola' });
});
```

Extensions never receive Nox's database connection or internal schemas.
