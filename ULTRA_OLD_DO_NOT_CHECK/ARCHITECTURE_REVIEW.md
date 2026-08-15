# Revisión de arquitectura de Nox

## Resumen de arquitectura

Nox es un **monolito modular local-first**:

- `index.ts`: bootstrap y shutdown.
- `src/config`: configuración desde archivos y variables de entorno.
- `src/provider`, `src/tool`, `src/gate`: abstracciones para modelos, herramientas y permisos.
- `src/agent`: sesiones, contexto y loop del agente.
- `src/gateway`: REST/SSE y futuros brokers externos.
- `src/database`: SQLite + Drizzle.
- `src/deliberation`, `src/deepResearch`: workflows colaborativos.
- `src/server`: API Elysia y UI estática.
- `ui`: Astro + Svelte islands + NanoStores.

La separación por dominios está bastante bien y ya existen buenas abstracciones para providers, tools, eventos y gates.

## Hallazgos prioritarios

### 🔴 1. El estado actual tiene una regresión real en `Context`

La encapsulación de `Context` quedó incompleta:

- `src/agent/context.ts:23` expone `listener` solamente como getter.
- `src/agent/registry.ts:250` intenta asignarle un valor.
- `Context.tools`, historiales y contadores se volvieron privados, pero `Runner`, los tests y `AgentRegistry` siguen accediéndolos directamente.
- `AgentSession` ya no expone `history`, aunque gateway y deliberation dependen de ella.

Resultado actual:

- `bun test`: **108 pasan, 2 fallan**.
- Las dos deliberaciones fallan en runtime con `Attempted to assign to readonly property`.
- `bunx tsc --noEmit`: **36 errores**.
- `bun run lint`: **1 error**.

Esto afecta también la creación normal de sesiones, no solamente deliberation.

**Recomendación:** terminar la API pública de `Context` mediante getters, setters o métodos explícitos (`setTools`, `setListener`, `history`, `usage`) y evitar que los consumidores manipulen sus campos internos.

### 🔴 2. El build puede publicar código que no compila/new

`package.json` no tiene un script de typecheck y el build actual usa:

```json
"build": "bun build index.ts ..."
```

Bun transpila sin detectar los 36 errores anteriores. La UI sí tiene `check`, pero tampoco forma parte de `build:all`.

**Recomendación:** incorporar verificaciones obligatorias:

```json
"check": "tsc --noEmit && bun run --cwd ui check",
"verify": "bun run check && bun run lint && bun test",
"build:all": "bun run verify && bun run build:ui && bun run build"
```

Es el cambio con mejor relación esfuerzo/beneficio para evitar otra regresión similar.

### 🟠 3. Singletons globales y lifecycle rígido

`AgentRegistry`, `ProviderRegistry`, `ToolRegistry`, `BrokerRegistry`, `MessageGateway` y los registries colaborativos son singletons globales. Esto produce:

- dependencias ocultas;
- inicialización sensible al orden;
- tests difíciles de aislar;
- rutas que inicializan servicios perezosamente aunque el bootstrap también los inicializa;
- poca capacidad para reiniciar o recargar servicios.

Además, `AgentRegistry.close()`:

- no detiene sesiones activas;
- no limpia `sessions`;
- no reinicia `initialized`.

`BrokerRegistry.stopAll()` tampoco permite volver a inicializarlo.

**Recomendación:** introducir un `NoxApplication` o `AppContext` que posea configuración, DB y servicios, e inyectarlo en rutas y runners. Los registries pueden seguir existiendo, pero como instancias normales.

### 🟠 4. Crecimiento de memoria sin límite

`AgentRegistry.sessions` conserva cada sesión creada o restaurada hasta que se elimina definitivamente. A su vez, `EventLog.events` mantiene todos los eventos en memoria.

Una deliberación crea hasta nueve sesiones y, al terminar, esas sesiones permanecen cacheadas. En un proceso longevo esto crecerá continuamente aunque todo ya esté persistido en SQLite.

**Recomendación:**

- separar “sesión activa” de “sesión persistida”;
- expulsar sesiones idle mediante TTL o LRU;
- detener y descargar las sesiones internas de una deliberación al terminar;
- usar un ring buffer para eventos en memoria y recuperar historia antigua desde SQLite.

### 🟠 5. Tres conexiones para la misma base de datos

Actualmente `AgentRegistry`, `DeepResearchRegistry` y `DeliberationRegistry` llaman independientemente a `openDatabase(databaseFile)`. Cada llamada:

- abre otra conexión;
- configura pragmas;
- vuelve a ejecutar migraciones;
- requiere shutdown separado.

**Recomendación:** abrir SQLite una vez en el bootstrap e inyectar `SessionStore`, `DeepResearchStore` y `DeliberationStore`. Esto también simplificaría transacciones entre dominios.

### 🟠 6. Operaciones de deliberación no atómicas

En `src/database/deliberationStore.ts`:

- `begin()` borra turnos y después actualiza el estado en operaciones separadas.
- Cada participante se inserta individualmente y luego se actualiza `currentRound`.
- La síntesis se inserta antes de marcar la deliberación como completada.

Un error intermedio puede dejar rondas parciales o una síntesis persistida con estado `failed`.

**Recomendación:** crear operaciones transaccionales como:

- `restartDeliberation()`;
- `commitRound(turns, round)`;
- `completeWithSynthesis(turn, result)`.

### 🟡 7. Los “registries” todavía son catálogos hardcodeados

Ejemplos:

- `ProviderRegistry` importa directamente `OpenAICompletions`.
- `ToolRegistry` registra directamente `WebTools`.
- `BrokerRegistry` tiene un catálogo vacío y recibe `{}` desde `index.ts`.
- Los esquemas de configuración se derivan de esos builtins.

Agregar un provider, tool o broker obliga a editar varios módulos centrales. Es un registry nominal, pero aún no un punto de extensión real.

**Recomendación:** exponer `registerProvider`, `registerToolSet` y `registerBroker`, o construir los registries con catálogos inyectados. No necesariamente hace falta un sistema dinámico de plugins todavía.

### 🟡 8. El protocolo de deliberación está fijo en código

`DeliberationRunner` impone:

1. propuesta;
2. críticas;
3. consenso desde la segunda ronda;
4. síntesis.

Prompts, fases y condición de terminación están codificados directamente. La DB solamente guarda `rounds`, no el protocolo ni su versión.

**Recomendación:** representar el workflow mediante un `DeliberationProtocol` versionado. Así se podrían añadir protocolos de debate, votación, revisión por roles o consenso configurable sin reescribir el runner.

### 🟡 9. El control de contexto todavía es superficial

- `Context.compact()` es un NO-OP y no tiene callers.
- `contextWindow` se puede configurar, pero no se usa en backend.
- Deliberation recorta el transcript por **48 000 caracteres**, no por tokens.
- Cada sesión también acumula su historia completa.

Con rondas configurables hasta 100, eventualmente aparecerán errores de contexto o costos crecientes.

**Recomendación:** presupuesto de tokens por modelo, compacción o summarization y límites coherentes entre transcript, historial y output esperado.

### 🟡 10. Configuración con varias inconsistencias

- `app.logLevel` se lee desde JSON, pero el logger usa exclusivamente `process.env.LOG_LEVEL` en `src/logger/index.ts:58`; el valor del archivo queda ignorado.
- Desarrollo usa por defecto `/etc/nox/config` y `/var/lib/nox`, poco amigable fuera de un paquete o container.
- `CONFIG_DIR_BLUEPRINTS` aparece duplicado en `src/config/env.ts:27-28`.
- Las escrituras usan `Bun.write` directamente sobre el archivo final y mutan el objeto cacheado antes de confirmar persistencia.
- Providers y tools guardados requieren reinicio porque sus registries son de inicialización única.

**Recomendación:** un `ConfigRepository` con escritura atómica, paths por entorno y semántica explícita de reload o restart.

### 🟡 11. Contratos backend/UI duplicados manualmente

`ui/src/utils/types.ts` replica los tipos del backend. El cliente `request<T>()` confía en casts sin validar la respuesta.

Eso permite que backend y UI diverjan; de hecho, el UI build pasa aunque el backend tenga 36 errores.

**Recomendación:** compartir contratos Zod en un paquete común o generar tipos y cliente desde OpenAPI.

También convendría dividir `ui/src/stores/playground.ts`, que ya tiene **787 líneas** y mezcla API, SSE, reconexión, timers, optimistic updates y reducers.

### 🟡 12. Frontera de seguridad dependiente de localhost

El default `127.0.0.1` es correcto para local-first, pero `HOST=0.0.0.0` expone una API sin autenticación que puede modificar configuración, operar agentes y consultar logs.

**Recomendación:** rechazar hosts no-loopback sin una opción explícita, o añadir autenticación cuando se habilite acceso remoto.

## Estado de verificaciones

- Backend tests: ❌ 108 pass / 2 fail.
- TypeScript backend: ❌ 36 errores.
- ESLint: ❌ 1 error.
- UI check: ✅ 0 errores, 4 warnings CSS.
- UI build: ✅ 17 páginas generadas.

## Orden de trabajo sugerido

1. Arreglar la API y encapsulación de `Context`.
2. Agregar un quality gate obligatorio.
3. Corregir lifecycle y crecimiento de memoria.
4. Centralizar la conexión a SQLite.
5. Añadir límites transaccionales a deliberation.
6. Desacoplar registries y protocolos.
7. Compartir contratos entre backend y UI.
8. Mejorar configuración, contexto y seguridad remota.

---

> Esta revisión corresponde al estado del árbol de trabajo al momento del análisis. El repositorio ya contenía modificaciones sin commit; no se modificó código fuente como parte de la revisión.
