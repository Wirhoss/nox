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

Commands are contributions. Their IDs become slash-command names, their Zod
parameters are rendered and validated by the host, and each invocation passes
through its declared authority and risk policy before it can run:

```ts
import { authorities, commands, defineCommand, defineExtension, z } from '@nox/extension-api';

export default defineExtension({
  activate(context) {
    context.contributions.register(authorities, 'example.extension.commands', {
      description: 'Use example commands.',
    });
    context.contributions.register(
      commands,
      'hello',
      defineCommand({
        authority: 'example.extension.commands',
        description: 'Greet someone.',
        parameters: z.object({ name: z.string() }),
        risk: () => ({ effects: [] }),
        run: async (_command, { name }) => ({ text: `Hello, ${name}.` }),
      }),
    );
  },
});
```

The command context exposes bounded operations for its current conversation, including inspection,
renaming, compaction, retry, and explicit session/agent/model transitions. It does not expose the kernel
session, gateway, provider, or database.
