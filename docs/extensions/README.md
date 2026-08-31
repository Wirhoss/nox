# Extensions

Current concrete capabilities such as providers, brokers, memories, tool sets,
commands, and language packs are packaged as extensions. Builtins and installed
packages use the same manifest parser, activation context, and contribution API.
The source boundary is checked in
[`src/boundaries.test.ts`](../../src/boundaries.test.ts); execution trust is
discussed under [Current limits](#current-limits).

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
  "services": ["nox.artifact-pipeline"],
  "hostPackages": { "sharp": "^0.35.3" },
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
owns (see [memory.md](memory.md) for a builtin that uses it); `workers`, naming
entry points loaded from a URL that a build has to emit separately;
`hostPackages`, the libraries it takes from the host rather than bundling (see
[Third-party libraries](#third-party-libraries)); and `services`.

`services` lists the host service IDs the package may resolve through
`context.services`. The container is scoped to this list: a token that is not
named raises `UndeclaredServiceError` from `get`, `tryGet`, and `has`. If the key
is absent, the scoped container declares no host services.

This makes supported host-service use visible in the manifest and catches a
missing declaration during activation. It does not restrict direct process APIs
such as filesystem or network access.

Declaring a service the host does not provide is not an error; it is a request
that stays unfilled. `get` raises `MissingServiceError` and `tryGet` answers
`undefined`, which is the existing way to write an optional dependency.

Both declarations are reported by the authenticated `/api/extensions` inventory,
per package and alongside its origin and state — including for a package that
failed to load, which is when the reader most needs them. It reports what the
package *asked* for, not what it was granted: a control-plane service named by
an installed extension shows up there and is still refused. Showing the request
is the point, because the request is the part worth reviewing.

Some services are the **control plane** and are reserved to Nox's own builtins:
writing configuration, enumerating which secrets exist and who consumes them,
running an agent unattended, the conversation hub itself. They are marked
`controlPlane` where the token is declared. An installed package that names one
is refused with `RestrictedServiceError` — a different error from the undeclared
case on purpose, because no manifest edit will grant it.

The refusal happens twice, at two different moments, and both are wanted. A
manifest that declares one is turned away at **discovery**, so a package that
can never have what it asked for is never counted as loaded; the scoped
container refuses again at the **call**, which is what catches a package
reaching for a token it never declared at all. Neither stops Nox: discovery
drops the one package, logs why, and rolls every other extension forward.

The `nox.` package namespace is reserved. Discovery rejects an installed package
that uses it, preventing an extension-owned authority prefix from overlapping
existing Nox grants. External packages should use a namespace they control; for
example, `acme.tools` owns `acme.tools.*` through the supported authority model.

Within the reserved namespace, the core uses `nox.core.*` and each builtin uses
its extension ID as its authority prefix, such as `nox.toolset.web.*` or
`nox.broker.discord.*`. This lets a grant target core authorities without also
targeting every builtin.

The manifest owns identity. Extension code does not duplicate or override it.
Entry points are confined to their package directory, duplicate IDs disable every
conflicting candidate, and activation failure rolls back that package's
contributions.

---

## The public API

The supported extension contract comes from the versioned
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

Three details illustrated by the example:

1. The config schema is part of the contribution. Settings can render it, and the
   host validates an entry before creating an instance.
2. The tool declares an `authority` and a `risk`; the Gate evaluates those fields
   before execution.
3. This tool set does not request host services and receives no database
   connection, session object, or internal configuration object through its
   activation context.

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

These are repository and extension-authoring commands. They do not install or
run Nox on the host; deployment uses the container image.

| Command | What it does |
|---|---|
| `bun run build:extension-api` | Builds the publishable public package |
| `bun run build:extensions` | Builds the API, then packages every builtin separately under `dist/extensions/builtin` and emits the runtime under `dist/node_modules` |
| `bun run build:host` | Builds the kernel bundle |

The container copies those outputs rather than compiling a static builtin
registry into the kernel.

### Third-party libraries

The current packaging path expects an extension to bundle ordinary JavaScript
dependencies unless Nox explicitly supplies them at runtime.

The host-provided list is exported as `HOST_PROVIDED_PACKAGES` from
`@nox/extension-api`. It currently includes packages that need shared runtime
identity or host-installed native binaries, including Zod, Sharp and
Transformers.

Extension builds can use `EXTENSION_EXTERNAL_PACKAGES`, which combines that list
with `@nox/extension-api`. The
[standalone example](../../examples/extensions/greeting-toolset/build.ts) shows
the current build setup. Importing the exported list avoids maintaining a second
copy in each extension build.

An extension that imports a host-provided package declares it in `hostPackages`
with a semver range:

```json
"hostPackages": { "zod": "^4.4.3", "sharp": "^0.35.3" }
```

Discovery checks the requested names and ranges beside the `engines` fields. An
unsupported name is a manifest error; an unavailable version marks the package
as incompatible. These cases have coverage in
[`loader.test.ts`](../../src/extensions/loader.test.ts) and
[`hostPackages.test.ts`](../../src/extensions/hostPackages.test.ts).

Arbitrary native dependencies outside the host list are not supported by the
current extension build and installation flow. This is a packaging limitation,
not a general claim that native packages can never be distributed.

---

## Current limits

Extensions are trusted in-process code, not a sandbox. The manifest `services`
list limits resolution through `context.services`, but extension code can still
use the filesystem, network, and other APIs available to the Nox process.
Operators should review installed extensions with that access in mind. Package
changes currently require a Nox restart.

The complete trust-boundary description is in
[../architecture.md](../architecture.md#trust-boundary).

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
