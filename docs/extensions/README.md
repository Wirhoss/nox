# Extensions

Every concrete capability in Nox is an extension. Builtins are not special —
they differ from third-party packages only in how they are discovered, never in
what they are or what API they use.

| Page | What is in it |
|---|---|
| [memory.md](memory.md) | The `semantic` memory builtin |
| [providers.md](providers.md) | Provider adapters and model modalities |
| [brokers.md](brokers.md) | The `web` and `discord` transports |
| [configuration.md](configuration.md) | The `config` tool set |
| [jobs.md](jobs.md) | The `cronjobs` tool set |
| [files.md](files.md) | Artifacts and processors |
| [models.md](models.md) | Models for internal tasks |

---

## Anatomy

An extension is one directory containing a manifest and a JavaScript entry
module:

```text
example.toolset/
├── nox-extension.json
└── extension.js
```

```json
{
  "schemaVersion": 1,
  "id": "example.toolset",
  "version": "1.4.2",
  "main": "extension.js",
  "engines": {
    "nox": "^0.1.0",
    "extensionApi": ">=0.1.0 <0.2.0"
  }
}
```

`version` identifies one exact installed artifact. Both compatibility
declarations are semver **ranges**: an extension can support a family of Nox and
Extension API releases rather than naming one build.

Optional keys: `migrations`, naming a directory of SQL migrations the extension
owns (see [memory.md](memory.md) for a builtin that uses it).

The manifest owns identity. Extension code does not duplicate or override it.
Entry points are confined to their package directory, duplicate IDs disable every
conflicting candidate, and activation failure rolls back that package's
contributions.

---

## The public API

Everything an extension needs comes from the versioned
[`@nox/extension-api`](../../packages/extension-api/) package. It imports no
kernel modules; its build emits ESM plus TypeScript declarations under `dist`.

Extension projects take it as a **development** dependency and keep it external
in their production bundle — Nox supplies the runtime selected by
`engines.extensionApi`. Builtins obey the same boundary: production builtin code
may import only its own package files and the public API.

A complete, independently compiled consumer lives at
[`examples/extensions/greeting-toolset`](../../examples/extensions/greeting-toolset).

---

## A working extension

This is the example above, abridged — a tool set with one tool, one authority,
and a config schema:

```ts
import {
  authorities,
  defineExtension,
  type MessageContent,
  type Tool,
  ToolSet,
  toolSetBaseConfigSchema,
  toolSetContribution,
  toolSets,
  z,
} from '@nox/extension-api';

const greetingConfigSchema = toolSetBaseConfigSchema.extend({
  salutation: z.string().trim().min(1).default('Hello'),
  type: z.literal('greeting'),
});

const GREET_AUTHORITY = 'example.greeting.use';

class GreetingToolSet extends ToolSet {
  static readonly configSchema = greetingConfigSchema;
  readonly #salutation: string;

  constructor(input: z.input<typeof greetingConfigSchema>) {
    const config = greetingConfigSchema.parse(input);
    super('Greeting', 'Produces a greeting without accessing host internals.', config.enabledTools);
    this.#salutation = config.salutation;
    this.addTools();
  }

  protected addTools(): void {
    const parameters = z.object({ name: z.string().trim().min(1) });
    const greet: Tool<typeof parameters> = {
      authority: GREET_AUTHORITY,
      description: 'Greet a named person.',
      name: 'greet',
      parameters,
      prepare: ({ name }) => ({
        run: (): Promise<MessageContent[]> =>
          Promise.resolve([{ text: `${this.#salutation}, ${name}!`, type: 'text' }]),
        title: `Greet ${name}`,
        type: 'immediate',
      }),
      risk: { effects: ['read'], reversible: true },
    };
    this.registerTool(greet);
  }
}

export default defineExtension({
  activate(context) {
    context.contributions.register(authorities, GREET_AUTHORITY, {
      description: 'Produce local greeting text.',
    });
    context.contributions.register(
      toolSets,
      'greeting',
      toolSetContribution({
        configSchema: GreetingToolSet.configSchema,
        create: (config) => new GreetingToolSet(config),
      }),
    );
  },
});
```

Three things worth noticing:

1. **The config schema is part of the contribution**, not documentation. Settings
   renders a form from it, and an invalid entry never becomes a live instance.
2. **Every tool declares an `authority` and a `risk`.** Those are what the Gate
   evaluates. A tool with no declared risk is not a cheaper tool; it is an
   unreviewable one.
3. **Nothing reaches into the host.** The tool set never sees a database
   connection, a session, or the config object.

---

## Commands

Extensions can contribute person-facing commands. The contribution ID *is* the
slash-command name; its Zod parameters become the JSON Schema rendered by Web or
Discord, and are validated again by the host.

```ts
import { authorities, commands, defineCommand, defineExtension, z } from '@nox/extension-api';

export default defineExtension({
  activate(context) {
    context.contributions.register(authorities, 'example.extension.commands', {
      description: 'Run the example extension commands.',
    });
    context.contributions.register(
      commands,
      'hello',
      defineCommand({
        authority: 'example.extension.commands',
        description: 'Greets someone without entering the model transcript.',
        parameters: z.object({ name: z.string() }),
        risk: () => ({ effects: [] }),
        run: async (_command, { name }) => ({ text: `Hello, ${name}.` }),
      }),
    );
  },
});
```

Command code receives a **bounded conversation context**, not Nox's internal
`Session` or database. It may inspect the current session, compact or rename it,
retry generation, start a new session, and explicitly switch its agent or model.

Results are delivered as command events and **never become words the model
reads**.

### The builtin session commands

`nox.commands.session` contributes `/commands`, `/help`, `/session`, `/tools`,
`/compact`, `/retry`, `/rename`, `/new`, `/agent` and `/model`. `/stop` remains
the host safety command.

Bare `/agent` and `/model` list the choices. Supplying one value switches
explicitly:

- An **agent handoff** starts a fresh linked session, so two agents never share
  one transcript.
- A **model switch** reopens the same transcript under a model available from
  that agent's configured provider.

Web accepts either JSON (`/agent {"agent":"worker"}`) or shorthand
(`/agent worker`) for a one-value command.

---

## Storage

Each activation receives `context.storage`: an atomic, durable JSON store
isolated by extension ID. No extension receives Nox's database connection or
schemas.

An extension that needs real tables declares a `migrations` directory in its
manifest and gets its own migrated schema instead.

---

## Building

| Command | What it does |
|---|---|
| `bun run build:extension-api` | Builds the publishable public package |
| `bun run build:extensions` | Builds the API, then packages every builtin separately under `dist/extensions/builtin` and emits the runtime under `dist/node_modules` |

The container copies those outputs rather than compiling a static builtin
registry into the kernel.

---

## Limits, stated plainly

Extensions are **trusted native code, not a sandbox**. Installing one grants it
everything the runtime has. Package changes currently require a Nox restart.

The full statement of that boundary, and what would have to exist before
third-party installation is acceptable, is in
[../architecture.md](../architecture.md#trust-boundary-stated-plainly).

---

## Languages and extension-owned UI copy

The browser contains message keys, not an embedded English catalog. Complete
languages are contributions at `nox.languages`; an extension that owns UI copy
contributes fragments at `nox.translations`.

| Route | Result |
|---|---|
| `GET /api/i18n/languages` | Available locales, direction, native name, fallback and configured locale |
| `GET /api/i18n/languages/:locale` | The resolved flat message catalog for one locale |

Both are public — the access screen needs a catalog before an account can
authenticate.

Builtin language packs today are `en` and `es`.
