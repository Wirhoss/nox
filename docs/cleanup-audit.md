# Auditoría de duplicación y plan de limpieza

> Estado: inventario exploratorio. No se ha aplicado ningún refactor como parte de esta auditoría.
> El único artefacto añadido por la auditoría es este documento.

## Propósito

Este documento registra los hallazgos de la revisión de Nox orientada a:

- código duplicado o casi duplicado;
- tipos, constantes, schemas y contratos declarados más de una vez;
- responsabilidades que conviene centralizar;
- componentes y composables reutilizables;
- manifests, versiones, lockfiles, scripts, CI, documentación e i18n susceptibles de divergir;
- infraestructura, fixtures y escenarios duplicados en tests;
- duplicación legítima que no conviene abstraer.

Debe servir como backlog para iniciar una limpieza incremental, no como instrucción para hacer un refactor masivo.

## Precauciones antes de empezar

- El worktree ya contenía muchos cambios locales antes de la auditoría. No usar `git reset`, `git checkout .`, limpiezas globales ni reformatos indiscriminados.
- Entre los cambios preexistentes se observaron eliminaciones como `src/tool/render.ts` y `src/utils/jsonSchema.ts`, además de modificaciones en runtime, tests, documentación, Docker y CI.
- Releer `git status` y los diffs relevantes antes de cada tarea: el estado puede haber seguido evolucionando después de esta fotografía.
- Hacer commits pequeños por contrato o responsabilidad, con pruebas antes y después.
- La raíz usa Zod 4.x y `src/ui/package.json` usa Zod 3.x. Compartir valores mediante `safeParse` es viable, pero compartir genéricos `ZodType` directamente requiere cuidado.

## Resumen ejecutivo

Los candidatos más importantes son:

1. Hacer de `@nox/extension-api` la fuente canónica de los contratos que cruzan la frontera de extensiones, especialmente artifacts.
2. Relacionar automáticamente los DTO HTTP del servidor con los schemas que valida la UI.
3. Corregir una divergencia concreta: `displayName` se conserva en el servidor de sesiones, pero el schema UI lo elimina.
4. Añadir guardas de repositorio para versiones, manifests, claves de configuración, vocabularios cerrados e i18n.
5. Eliminar o justificar `package-lock.json`, actualmente obsoleto frente al grafo Bun.
6. Extraer el ciclo común de los editores de Settings sin construir un megaeditor.
7. Unificar la reconciliación común de providers y memories, dejando brokers, agents y tool sets especializados.
8. Consolidar `Mutex`, `stableStringify`, `WEB_BROKER_ID` y validaciones de IDs/URLs.
9. Reducir duplicación de harnesses, fixtures y mocks en tests.
10. Dividir varias suites de más de mil líneas por responsabilidad.

## Prioridades

- **P1 — alta:** divergencia contractual, pérdida de datos, release reproducible o riesgo de incompatibilidad pública.
- **P2 — media:** duplicación con alto coste de mantenimiento o elevada probabilidad de deriva.
- **P3 — baja:** limpieza útil, pero sin divergencia actual significativa.

---

# Hallazgos de código y contratos

## CLN-001 — Contrato de artifacts duplicado entre kernel y Extension API

**Prioridad:** P1  
**Impacto:** alto  
**Riesgo del refactor:** medio

### Evidencia

Duplicación exacta o casi exacta:

- `src/artifact/types.ts:3-68`
- `packages/extension-api/src/artifacts.ts:3-58`

En particular:

- `ARTIFACT_SCOPE_TYPES`;
- `ARTIFACT_PROVENANCE_TYPES`;
- `mediaTypeSchema`;
- `artifactIdSchema`;
- `artifactRefSchema`;
- `artifactScopeSchema`;
- `artifactProvenanceSchema`;
- `ArtifactRef`, `ArtifactScope`, `ArtifactRecord`, `ArtifactIngestInput` y tipos asociados.

Representaciones:

- `src/artifact/representation.ts:49-89`
- `packages/extension-api/src/artifacts.ts:62-100`

Errores y guards:

- `src/artifact/error.ts:29-74`
- `packages/extension-api/src/artifacts.ts:180-225`

### Riesgo

Una extensión puede compilar contra una definición y el kernel ejecutar otra. Los schemas, errores y guards son parte de una frontera pública y una diferencia pequeña puede convertirse en incompatibilidad de runtime.

### Propuesta

- Tratar `packages/extension-api/src/artifacts.ts` como fuente canónica de los tipos, schemas, errores y guards que cruzan la frontera.
- Migrar consumidores del kernel para importar directamente desde `@nox/extension-api`.
- Mantener en el kernel solo tipos, errores y comportamiento estrictamente internos, como cuotas o detalles de persistencia que no forman parte del contrato público.
- No crear módulos de compatibilidad que reexporten la API pública: `src/boundaries.test.ts` prohíbe correctamente ese patrón.
- Conservar guards estructurales para errores. El host inyecta/incluye la API de forma distinta a las extensiones externas, por lo que no se debe depender solo de `instanceof`.

### Pruebas afectadas

- `src/artifact/*.test.ts`
- `src/api/artifacts/routes.test.ts`
- `src/extensions/content.contract.test.ts`
- `src/extensions/extensionConsumer.test.ts`
- tests del processor Sharp
- `src/boundaries.test.ts`

---

## CLN-002 — `stableStringify` y `Mutex` duplicados exactamente

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del refactor:** bajo

### Evidencia

`stableStringify`:

- `packages/extension-api/src/core.ts:27-38`
- `src/utils/json.ts:10-30`

`Mutex`:

- `packages/extension-api/src/core.ts:41-59`
- `src/utils/mutex.ts:5-25`

El kernel ya importa `stableStringify` desde `@nox/extension-api` en algunos módulos, mientras otros siguen usando la copia local.

### Propuesta

- Usar la implementación de `@nox/extension-api` en el kernel.
- Mantener en `src/utils/json.ts` únicamente `diffPaths` e `isPlainObject` si siguen siendo internos.
- Trasladar o adaptar `src/utils/mutex.test.ts` al propietario canónico.

---

## CLN-003 — `WEB_BROKER_ID` tiene dos fuentes

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del refactor:** bajo

### Evidencia

- `packages/extension-api/src/index.ts:28`
- `src/api/chat/id.ts:2`

La extensión Web y la UI usan la constante pública, mientras `src/api/artifacts/routes.ts` usa la copia del kernel.

### Propuesta

Eliminar la copia de `src/api/chat/id.ts` y usar `WEB_BROKER_ID` desde `@nox/extension-api` en todos los consumidores.

---

## CLN-004 — Vocabularios cerrados repetidos

**Prioridad:** P1  
**Impacto:** alto  
**Riesgo del refactor:** medio-bajo

### Evidencia

Claves de configuración:

- `CONFIG_KEYS` en `packages/extension-api/src/services.ts:10`
- claves reales inferidas de `src/config/sections.ts`

No se encontró una aserción exacta que obligue a ambas listas a coincidir.

Estados y triggers de ejecución:

- `RunStatus` y `RunTrigger` en `packages/extension-api/src/brokers.ts:7-8`
- equivalentes en `packages/extension-api/src/memory.ts:251-252`
- equivalentes en `src/agent/events.ts:7-13`
- enums manuales en `src/ui/features/chat/api/chat.schemas.ts`

Riesgo de herramientas:

- `ToolEffect` y `ToolResourceKind` en `packages/extension-api/src/tools.ts`
- listas manuales en `src/ui/features/chat/api/chat.schemas.ts`
- listas manuales en `src/ui/features/sessions/api/sessions.api.ts`

Tipos de Gate/runtime repetidos:

- `RunAuthority`, `RiskSignal`, `PermissionRequest` y `PermissionResolution` en la API pública y el kernel.

`ConfigApply` también aparece en la API pública y `src/config/section.ts`.

### Riesgo

Agregar una clave, estado, trigger, efecto o tipo de recurso puede romper una UI o una extensión sin que el compilador relacione las dos definiciones.

### Propuesta

- Exportar constantes canónicas como `RUN_STATUSES`, `RUN_TRIGGERS`, `TOOL_EFFECTS` y `TOOL_RESOURCE_KINDS`.
- Derivar los tipos TypeScript y los enums Zod desde esas constantes cuando sea viable.
- Añadir una prueba exacta entre `CONFIG_KEYS` y `Object.keys(sections)`.
- Hacer que el kernel importe los tipos públicos que realmente cruzan la frontera.
- Usar como modelo el patrón ya existente en `src/agent/context/message.ts`, donde `MESSAGE_ROLES` tiene una aserción de exhaustividad contra `Message['role']`.

---

## CLN-005 — `parseOrThrow` duplicado

**Prioridad:** P3  
**Impacto:** bajo  
**Riesgo del refactor:** bajo

### Evidencia

- `src/utils/validate.ts:3`
- implementación privada similar en `packages/extension-api/src/providers.ts:485`

### Evaluación

La lógica y el formato de errores son prácticamente iguales. Sin embargo, convertirla en API pública solo para evitar esta copia puede ensanchar innecesariamente el contrato.

### Propuesta

- Consolidarla dentro de la Extension API solo si aparecen más consumidores públicos.
- De lo contrario, mantener ambas y añadir una prueba de formato si la igualdad de mensajes es importante.

---

# Contratos HTTP y UI

## CLN-006 — Contrato de chat declarado manualmente otra vez en la UI

**Prioridad:** P1  
**Impacto:** alto  
**Riesgo del refactor:** medio-alto

### Evidencia

Contrato público de tipos:

- `packages/extension-api/src/chat.ts`
- `packages/extension-api/src/content.ts`
- `packages/extension-api/src/artifacts.ts`
- `packages/extension-api/src/brokers.ts`

Schemas de recepción en la UI:

- `src/ui/features/chat/api/chat.schemas.ts`

La UI vuelve a declarar:

- referencias de artifacts;
- contenido de mensajes;
- eventos de chat;
- uso de contexto y tokens;
- riesgos y permisos;
- historial y conversaciones;
- estados y triggers de ejecución.

### Divergencias observadas

- El contrato público exige `content` en varios eventos y entradas; la UI lo acepta como opcional.
- El schema UI de artifacts es más permisivo que `artifactRefSchema`.
- El schema UI de contenido URL no replica todas las restricciones de HTTP(S), media type y texto del contrato canónico.
- Los enums de riesgo y ejecución están copiados manualmente.

### Propuesta incremental

1. Añadir aserciones de compatibilidad de tipos entre `z.infer` de la UI y los tipos públicos.
2. Añadir pruebas de serializadores reales del servidor contra el contrato consumidor.
3. Decidir si la opcionalidad de `content` es compatibilidad deliberada; si lo es, documentarla y versionarla. Si no, hacerla requerida.
4. A medio plazo, valorar un paquete neutral de contratos HTTP/runtime.

### Restricción Zod

La UI usa Zod 3 y la API pública Zod 4. No pasar schemas Zod 4 a funciones genéricas tipadas específicamente como Zod 3 sin un adaptador estructural o una migración. Los imports de tipos y las llamadas directas a `safeParse` no presentan el mismo problema.

---

## CLN-007 — Pérdida concreta de `displayName` en sesiones

**Prioridad:** P1  
**Impacto:** alto para conversaciones compartidas  
**Riesgo del arreglo:** bajo

### Evidencia

- `MessageOrigin.displayName` está declarado en `packages/extension-api/src/content.ts:147-159`.
- Gateway y runner lo conservan.
- `src/api/sessions/routes.ts` serializa el mensaje mediante spread, por lo que conserva `origin.displayName`.
- `src/ui/features/sessions/api/sessions.api.ts:34` declara `origin` solo con `principal` y `transportMessageId`.
- Zod elimina las propiedades desconocidas al devolver `parsed.data`.
- `src/ui/features/sessions/components/SessionTranscript.vue` tampoco muestra nombre ni principal del participante.

### Consecuencia

El dato llega desde el servidor, pero desaparece durante la validación UI. En una conversación compartida, el historial muestra varias entradas `User` sin distinguir claramente quién habló.

### Propuesta

- Añadir `displayName` al schema UI.
- Mostrar `displayName` y una referencia estable al principal en el transcript.
- Añadir cobertura en `src/api/sessions/routes.test.ts` y `src/ui/routes/SessionsRoute.vitest.ts`.
- Incluir este escenario en una prueba contractual servidor/consumidor.

---

## CLN-008 — DTO de Settings duplicado frente a los servicios públicos

**Prioridad:** P1  
**Impacto:** medio-alto  
**Riesgo del refactor:** medio

### Evidencia

`src/ui/features/settings/api/settings.api.ts` vuelve a declarar schemas y tipos equivalentes a:

- `ConfigSectionSummary`;
- `RuntimeComponentStatus`;
- `ProviderInventory`;
- `ProviderModelInventory`;
- `ToolInventory`;
- `ToolSetInventory`;
- referencias y consumidores de secretos;
- políticas host de brokers;
- claves, applies, editor, group e inventory de secciones.

Las versiones UI suelen ser más amplias: por ejemplo, varias claves se tipan como `string` aunque el contrato público usa `ConfigKey`.

### Propuesta

- Añadir comprobaciones de subtipo/exactitud para los DTO duplicados.
- Usar tipos públicos directamente cuando el dato sea realmente el mismo contrato.
- Mantener schemas runtime en UI mientras sea necesario, pero obligarlos a producir tipos compatibles.

---

# Settings UI

## CLN-009 — Editores de contribuciones altamente similares

**Prioridad:** P2  
**Impacto:** alto en mantenimiento UI  
**Riesgo del refactor:** medio

### Evidencia

- `ProviderEditor.vue` y `ToolSetEditor.vue` comparten aproximadamente un 56,8 % de similitud.
- `ProviderEditor.vue:364-394` y `ToolSetEditor.vue:465-495` contienen un bloque prácticamente idéntico.
- `BrokerEditor.vue` repite buena parte del mismo ciclo, aunque con lógica de dominio más extensa.
- `AppEditor.vue` y `AgentEditor.vue` también repiten partes del modo formulario/JSON.

Responsabilidades repetidas:

- modo `form`/`json`;
- `jsonSource`;
- firma original y dirty state;
- `parseJson` y `formatJson`;
- cambio de modo;
- limpieza de feedback;
- confirmación al abandonar ruta;
- clonación JSON;
- creación, guardado y eliminación;
- manejo de credenciales write-only.

### Propuesta

Extraer piezas pequeñas:

- `useConfigEditorLifecycle` para modo, JSON, firma y route guards;
- utilidad de clonación/config signatures;
- helper de feedback de campos;
- helper/composable para credenciales administradas;
- validaciones compartidas.

### No hacer

No convertir Provider, Tool Set, Broker, Agent y App en un único componente con multitud de flags. Las diferencias de dominio son reales y un megaeditor sería más difícil de mantener que la duplicación actual.

---

## CLN-010 — Validaciones de IDs, secretos y URLs repetidas

**Prioridad:** P1  
**Impacto:** medio-alto  
**Riesgo del arreglo:** bajo-medio

### Evidencia

Validaciones manuales en:

- `ProviderEditor.vue:377-391`
- `ToolSetEditor.vue:478-492`
- `BrokerEditor.vue:782-803`
- `AgentEditor.vue:658`
- `ConfigJsonEditor.vue:86`
- `SecretsManager.vue:61`

Schemas canónicos:

- `entryIdSchema` en `packages/extension-api/src/schemas.ts`
- `secretIdSchema` en el mismo archivo
- `httpUrlSchema` en el mismo archivo

### Divergencia concreta

`httpUrlSchema()` rechaza URLs que llevan usuario o contraseña incrustados. Los `validHttpUrl()` de los editores solo comprueban que el protocolo sea `http:` o `https:`.

La UI puede considerar válido algo que el backend rechazará después.

### Propuesta

Crear una utilidad de Settings que use los schemas canónicos mediante `safeParse`. Si importar el barrel público aumenta demasiado el bundle, exponer predicates ligeros o subpaths desde la Extension API.

---

## CLN-011 — Gestión de credenciales repetida en editores

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del refactor:** medio

### Evidencia

Provider, Tool Set y Broker repiten:

- estado `newId`, `selection`, `value`;
- detección de inputs dirty;
- sincronización desde referencias `$secret`;
- validación de IDs;
- agrupación de writes por secret ID;
- detección de valores contradictorios para un mismo ID;
- limpieza de feedback.

`managedSecrets.ts` actualmente solo contiene `NEW_SECRET` y el tipo de estado.

### Propuesta

Ampliar el modelo de managed secrets con funciones puras para:

- inicializar estados desde campos activos;
- detectar dirty;
- consolidar writes;
- reportar conflicto/ID inválido;
- mantener en Broker únicamente la regla específica de “guardar antes de habilitar”.

---

# Runtime y almacenamiento

## CLN-012 — Reconciliación repetida en `ConfigurationRuntimeController`

**Prioridad:** P2  
**Impacto:** alto  
**Riesgo del refactor:** medio-alto

### Evidencia

`#reconcileProviders` y `#reconcileMemories` en `src/runtime/configurationRuntime.ts` repiten casi el mismo algoritmo:

1. leer configuración deseada;
2. calcular firma con secret revision;
3. mantener generación activa si no cambió;
4. marcar `applying`;
5. crear candidato;
6. reemplazar y superseder instancia anterior;
7. marcar `active`;
8. conservar generación previa ante fallo;
9. bloquear eliminación si sigue referenciada;
10. retirar y limpiar status cuando desaparece.

También se repite la construcción manual de `RuntimeComponentStatus` en providers, memories, agents, brokers y tool sets.

### Propuesta incremental

1. Extraer primero helpers de status: active, applying, failure, unavailable y retained-by-reference.
2. Extraer después un reconciliador genérico únicamente para providers y memories.
3. Mantener especializados:
   - brokers, por replace/remove y rutas activas;
   - agents, por sesiones y dependencias;
   - tool sets, porque su catálogo ya administra parte del lifecycle.

### Pruebas afectadas

Principalmente `src/bootstrap.test.ts` y tests de configuración/recovery. No existe un test unitario pequeño dedicado solo a `ConfigurationRuntimeController`; gran parte de su cobertura está integrada en Bootstrap.

---

## CLN-013 — Stores UI repiten estado async y versionado de peticiones

**Prioridad:** P3  
**Impacto:** medio  
**Riesgo del refactor:** medio-bajo

### Evidencia

- `settings.store.ts`
- `memory.store.ts`
- `sessions.store.ts`
- partes de `activeSession.store.ts`

Patrones repetidos:

- uniones `idle/loading/ready/failed`;
- `navigationVersion`, `detailVersion` o `loadVersion`;
- comprobación de respuesta obsoleta;
- redirección al login en 401;
- clasificación de `ApiConnectionError`, `ApiContractError` y `ApiError`.

### Propuesta

- `AsyncResourceState` compartido;
- helper pequeño de epochs/versiones, sin ocultar la operación;
- clasificador base de errores HTTP;
- mantener mensajes y códigos específicos en cada store.

No crear un store base orientado a herencia.

---

## CLN-014 — Providers de almacenamiento de extensiones repiten lifecycle

**Prioridad:** P3  
**Impacto:** medio  
**Riesgo del refactor:** medio

### Evidencia

En `src/extensions/storage.ts`, `DatabaseExtensionStorageProvider` y `MemoryExtensionStorageProvider` repiten:

- map de storages por extension ID;
- validación de estado cerrado;
- memoización de promesas de apertura;
- eliminación de la promesa fallida;
- cierre idempotente;
- limpieza de maps y database.

### Diferencias legítimas

- El provider de disco crea directorios.
- El provider de disco importa el estado histórico desde la base del kernel.
- El provider de memoria usa `:memory:`.

### Propuesta

Extraer el lifecycle/caché mediante composición o funciones internas. Evitar una jerarquía compleja: las diferencias deben seguir visibles como hooks pequeños.

---

# Manifests, versiones, lockfiles, scripts y CI

## CLN-015 — `package-lock.json` está obsoleto

**Prioridad:** P1  
**Impacto:** alto para reproducibilidad  
**Riesgo del arreglo:** bajo

### Evidencia

El lock npm actual:

- solo registra `src/ui` como workspace;
- no contiene `packages/extension-api`;
- no contiene dependencias raíz actuales como `@huggingface/transformers` y `sqlite-vec`;
- no representa el mismo grafo que `package.json` y `bun.lock`.

CI, Docker y documentación usan Bun y `bun.lock`.

### Propuesta

- Eliminar `package-lock.json` si npm no es una ruta soportada.
- Si se decide soportar npm, regenerarlo y añadir una instalación npm real a CI.
- Documentar una sola política de package manager.

---

## CLN-016 — Versiones repartidas y guardas incompletas

**Prioridad:** P1  
**Impacto:** alto en releases  
**Riesgo del arreglo:** bajo-medio

### Evidencia

La versión `0.1.0` aparece en:

- `package.json` raíz;
- `src/version.ts`;
- `packages/extension-api/package.json`;
- `EXTENSION_API_VERSION` en `packages/extension-api/src/core.ts`;
- manifests builtin;
- fixtures runtime;
- ejemplo standalone;
- README y documentación;
- argumentos Docker.

Salvaguarda existente:

- `src/version.test.ts` comprueba que `NOX_VERSION` coincide con `package.json` raíz.
- Release verifica el tag frente al `package.json` raíz y ejecuta CI.

Huecos:

- no se encontró prueba equivalente para `EXTENSION_API_VERSION` frente al package de la API;
- no hay una prueba global de compatibilidad de todos los manifests con las versiones actuales;
- documentación y ejemplos pueden quedarse atrás.

### Propuesta

Definir primero la política:

- si Nox, Extension API y builtins versionan en lockstep, derivar o comprobar igualdad;
- si versionan independientemente, comprobar solo invariantes correctas:
  - constante API = versión de su package;
  - rangos `engines` aceptan las versiones actuales;
  - manifests builtin son compatibles;
  - ejemplos declaran rangos compatibles.

Usar placeholders en documentación cuando el número exacto no aporte valor.

---

## CLN-017 — Versión de Bun repetida

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del arreglo:** bajo

### Evidencia

- `Dockerfile:7`
- `.github/workflows/ci.yml:22`
- `.github/workflows/release.yml:13`

Actualmente las tres copias indican `1.3.14`.

### Propuesta

- Fuente única si las herramientas lo permiten, por ejemplo `packageManager` o archivo de versión.
- Si Docker no puede consumirla directamente, añadir una prueba/script que compare automáticamente las tres declaraciones.

---

## CLN-018 — Build de extensiones no valida el manifest completo

**Prioridad:** P1  
**Impacto:** alto  
**Riesgo del arreglo:** bajo-medio

### Evidencia

`scripts/build-extensions.ts:60-64`:

- hace `JSON.parse`;
- comprueba únicamente que `id` y `main` sean strings;
- no aplica `extensionManifestSchema` ni `parseExtensionManifest`.

Puede compilar un package cuyo manifest se rechace posteriormente al descubrirlo.

### Propuesta

- Validar cada manifest con el parser canónico durante el build.
- Verificar que `main`, `workers` y `migrations` existan.
- Verificar compatibilidad de engines.
- Hacer que el build falle antes de producir un artifact inválido.

---

## CLN-019 — Falta contrato automático entre manifests y código

**Prioridad:** P2  
**Impacto:** medio-alto  
**Riesgo del arreglo:** medio

### Estado actual comprobado

Los 12 manifests builtin actuales son coherentes:

- IDs y namespaces;
- servicios declarados frente a los usados mediante `context.services`;
- rangos de `hostPackages` frente a `package.json`;
- engines actuales.

### Hueco

No hay una prueba de repositorio única que garantice esa coherencia en el futuro. Las activaciones integradas detectan parte de los errores, pero no expresan todos estos invariantes como contrato explícito.

### Propuesta

Crear una prueba de builtins que:

- descubra los 12 manifests;
- los valide canónicamente;
- compruebe paths;
- compruebe compatibilidad;
- active los packages con sus servicios declarados;
- compruebe que no piden servicios no declarados;
- compruebe host package ranges.

Evitar un scanner textual frágil cuando la activación real pueda demostrar el mismo contrato.

---

## CLN-020 — El ejemplo standalone no se prueba como package real

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del arreglo:** bajo

### Evidencia

`src/extensions/extensionConsumer.test.ts` compila y ejecuta el source del ejemplo, pero genera un manifest propio. No prueba conjuntamente:

- `examples/extensions/greeting-toolset/package.json`;
- su `build.ts` real;
- su `nox-extension.json` real;
- la ruta `main` producida.

### Propuesta

Añadir un job o test que ejecute el build real del ejemplo en un directorio limpio, valide su manifest y lo descubra como package instalado.

---

# i18n y documentación

## CLN-021 — Paridad i18n actual correcta, sin guarda global

**Prioridad:** P2  
**Impacto:** medio  
**Riesgo del arreglo:** bajo

### Estado comprobado

Catálogo principal:

- inglés: 918 claves;
- español: 918 claves;
- paridad completa.

Fragmentos de extensiones:

- Discord broker: 38/38;
- Semantic memory: 14/14;
- Local provider: 11/11;
- OpenAI provider: 57/57;
- Config tool set: 23/23;
- Cronjobs tool set: 11/11;
- Web tool set: 58/58.

### Hueco

No existe una prueba global que descubra todos los pares y obligue a conservar la paridad.

### Propuesta

Una prueba contractual global que valide:

- mismas claves EN/ES;
- namespaces correctos;
- locales normalizados;
- ausencia de claves fuera del namespace cuando aplique;
- todos los fragmentos registrados por una extensión.

---

## CLN-022 — Registro de traducciones repetido en siete extensiones

**Prioridad:** P3  
**Impacto:** bajo-medio  
**Riesgo del refactor:** bajo

### Evidencia

Siete extensiones repiten dos llamadas a `context.contributions.register` con:

- `translationFragments`;
- ID `${namespace}.en` / `${namespace}.es`;
- `defineTranslationFragment`;
- locale, namespace y messages.

### Propuesta

Helper genérico, no limitado a dos idiomas, por ejemplo:

```ts
registerTranslationFragments(context, namespace, {
  en: englishMessages,
  es: spanishMessages,
})
```

Debe seguir usando el registro normal para conservar ownership y disposal.

---

## CLN-023 — Catálogo manual extenso en tests UI

**Prioridad:** P3  
**Impacto:** medio  
**Riesgo del refactor:** bajo-medio

### Evidencia

`src/ui/tests/setup.ts` instala manualmente unas 309 claves y ocupa aproximadamente 16 KB.

La separación es intencional: el comentario de `installTestLanguage` indica que los tests UI no deben cruzar la frontera HTTP importando un builtin.

### Propuesta

- No importar directamente el language builtin desde producción UI.
- Mover copy específica a fixtures por feature cuando sea posible.
- Usar handlers del endpoint i18n y el flujo productivo en tests de integración de App.
- Añadir una prueba de repositorio que extraiga claves estáticas `t('...')` y compruebe su existencia en el catálogo real, aceptando excepciones para claves dinámicas.

---

## CLN-024 — Variable documentada que no existe

**Prioridad:** P1  
**Impacto:** medio  
**Riesgo del arreglo:** bajo

### Evidencia

`docs/configuration.md:27` documenta:

```text
NOX_SESSION_ID — Resumes that session on start
```

No se encontró ningún consumidor de `NOX_SESSION_ID` en el código. Solo aparece en la documentación.

### Propuesta

Eliminarla de la documentación o implementar explícitamente la funcionalidad si sigue siendo un requisito vigente.

---

## CLN-025 — Duplicación documental legítima

**Prioridad:** sin acción inmediata

El quickstart de `README.md` y `docs/deployment.md` comparte un bloque corto de comandos. Es razonable que el README sea autosuficiente y el documento de deployment amplíe el procedimiento.

No se recomienda introducir includes, generación o enlaces que obliguen a abandonar el README para poder arrancar el proyecto.

---

# Hallazgos en tests

## Estado general

En la fotografía analizada:

- 119 archivos de test;
- aproximadamente 35.394 líneas de tests;
- 97 archivos de kernel y 22 de UI;
- no se encontraron tests completos claramente idénticos entre archivos;
- la duplicación está concentrada en setup, cleanup, fixtures, mocks, providers falsos y contratos copiados.

## TST-001 — Lifecycle de SQLite temporal repetido

**Prioridad:** P2

### Evidencia

El mismo patrón de `directories`, `opened`, `openDatabase()` y `afterEach()` aparece en al menos ocho suites:

- `src/agent/agent.test.ts`
- `src/agent/authorization.test.ts`
- `src/agent/longSession.test.ts`
- `src/agent/session.test.ts`
- `src/database/database.test.ts`
- `src/database/historyIndex.test.ts`
- `src/database/sessionStore.test.ts`
- `src/gateway/gateway.test.ts`

También existen variantes async en tests API.

### Propuesta

Crear soporte explícito, por ejemplo:

```ts
const resources = new TestResources()
afterEach(() => resources.dispose())
const database = await resources.database('agent')
```

Cada suite debe tener su propia instancia para no mezclar recursos bajo ejecución concurrente.

---

## TST-002 — Harness de API autenticada repetido

**Prioridad:** P2

### Evidencia

`blueprintNox`, `configNox`, `chatNox`, `secretNox`, `sessionNox` y otros repiten:

1. temp directory;
2. database;
3. `AuthStore`;
4. registro de `wirhoss`;
5. sesión y Bearer token;
6. `ApiServer` en puerto 0;
7. arrays globales de cleanup;
8. cierre y `rm` tolerante con Windows.

La contraseña `correct-horse-battery` aparece en al menos nueve archivos.

### Propuesta

Extraer piezas pequeñas:

- `claimedAuth(resources)`;
- `authorizationHeaders(tokens)`;
- `resources.startApi(options)`;
- `TEST_PASSWORD`.

No crear un builder universal con decenas de flags que esconda qué servicios monta cada test.

---

## TST-003 — Helpers de App/UI exactamente repetidos

**Prioridad:** P2

### Evidencia

`authenticatedOperator()` y `renderAt(path)` son idénticos en:

- `src/ui/routes/MemoryRoute.vitest.ts`
- `src/ui/routes/SessionsRoute.vitest.ts`
- `src/ui/routes/SettingsRoute.vitest.ts`

### Propuesta

Moverlos a `src/ui/tests/appHarness.ts`:

- `authenticatedOperatorHandlers()`;
- `renderAppAt(path)`.

Mantener handlers específicos de Memory, Sessions y Settings en sus propias suites.

---

## TST-004 — Tests de extensiones usan manifests sintéticos duplicados

**Prioridad:** P1

### Evidencia

Cinco tests definen el mismo helper `started()` con un manifest inline:

- Discord;
- OpenAI;
- Config tool set;
- Cronjobs tool set;
- Web tool set.

### Riesgo

El test puede pasar con un manifest sintético correcto aunque el `nox-extension.json` real esté roto o desactualizado.

### Propuesta

`startExtensionFixture(import.meta.dir, extension)` debe leer y validar el manifest real adyacente. Esto reduce duplicación y convierte el manifest distribuido en parte de la prueba.

---

## TST-005 — Paridad de traducciones probada varias veces y solo parcialmente

**Prioridad:** P2

### Evidencia

Comparaciones EN/ES casi idénticas en tests de OpenAI, Web, Config y Cronjobs. Las otras extensiones con fragmentos no tienen la misma comprobación local.

### Propuesta

- Mover paridad a una prueba contractual global.
- Mantener en tests individuales únicamente ownership, namespace y una traducción representativa si aporta valor al comportamiento concreto.

---

## TST-006 — Model/provider/tool fixtures repetidos

**Prioridad:** P3

### Evidencia

- `MODEL` aparece en siete suites de agent/gateway.
- `ScriptedProvider` aparece en Runner, Session y Provider.
- `TestToolSet` aparece en Agent, Authorization y Gateway.
- `echoTool` aparece en cuatro suites.
- `says()` y `calls()` aparecen en Runner y Session.
- Muchos providers falsos repiten constructor `maxRetries: 0` y `fetchModelIds() => []`.

### Propuesta

Añadir a soporte de tests:

- `TEST_CHAT_MODEL`;
- clase base mínima `TestChatProvider`;
- `ScriptedChatProvider` reusable;
- generadores de eventos como `textResponse()` y `toolCallResponse()`;
- `TestToolSet` solo si su semántica realmente coincide.

### No hacer

No fusionar providers que modelan decisiones distintas — routing, autorización, attachments, deferred work o errores. La implementación local de esos dobles explica el escenario y debe seguir visible.

---

## TST-007 — Helper `rejection` repetido con semánticas distintas

**Prioridad:** P3

### Evidencia

Siete suites tienen una función `rejection`; algunas devuelven `Error` y otras `unknown`.

### Propuesta

Dos helpers con nombres explícitos:

```ts
rejectionOf(promise): Promise<unknown>
errorFrom(promise): Promise<Error>
```

Usar `expect(...).rejects` directamente cuando no sea necesario inspeccionar el objeto rechazado.

---

## TST-008 — Fixture de Sessions duplicada entre servidor y UI

**Prioridad:** P1

### Evidencia

`src/api/sessions/routes.test.ts` crea un escenario completo con:

- sesiones;
- transcript;
- autorización y Gate;
- riesgos;
- permission pending;
- tool responses;
- artifacts.

`src/ui/routes/SessionsRoute.vitest.ts` reproduce manualmente casi el mismo DTO como handlers MSW.

### Riesgo

Servidor y UI pueden divergir y ambos tests seguir verdes porque cada lado valida su propia copia. La pérdida de `displayName` demuestra este problema.

### Propuesta preferida

Una prueba de contrato consumidor/productor donde la respuesta serializada real del servidor sea validada por el contrato consumidor de UI.

Compartir una fixture estática es mejor que dos copias, pero no sustituye la validación del serializador real y puede volver el test tautológico si el expected y el producer usan el mismo objeto.

---

## TST-009 — Fixture de Settings copia el catálogo de producción

**Prioridad:** P2

### Evidencia

`src/ui/routes/SettingsRoute.vitest.ts:1301-1376` contiene una tabla manual con:

- descripción;
- editor;
- group;
- label/plural;
- references;
- inventory;
- slug;
- entry summaries;
- creatable/applies.

Es casi una copia del catálogo canónico de `src/config/sections.ts`.

El mismo test también contiene representaciones extensas de schemas de OpenAI, Local, Web y brokers.

### Evaluación

Hay dos intenciones mezcladas:

1. fixture independiente para probar que el editor es genérico ante JSON Schema externo;
2. snapshot informal de lo que publican las extensiones reales.

La primera es legítima; la segunda puede derivar.

### Propuesta

- Centralizar builders de DTO UI en `src/ui/tests/settingsFixtures.ts`.
- Nombrar schemas representativos como fixtures independientes, sin prometer que son una copia exacta del builtin.
- Para el contrato real, generar/validar snapshots desde la respuesta del servidor o añadir una prueba contractual separada.

---

## TST-010 — Suites monolíticas

**Prioridad:** P2

### Evidencia

| Archivo | Líneas aproximadas |
|---|---:|
| `src/gateway/gateway.test.ts` | 2.047 |
| `src/ui/routes/SettingsRoute.vitest.ts` | 1.583 |
| `src/agent/runner.test.ts` | 1.518 |
| `src/agent/authorization.test.ts` | 1.506 |
| `src/bootstrap.test.ts` | 1.309 |
| `openAICompletions.test.ts` | 1.290 |
| `semanticMemory.test.ts` | 1.143 |
| `src/api/config/config.test.ts` | 1.033 |
| `src/config/config.test.ts` | 931 |

### Propuesta de separación

Gateway:

- scheduled delivery;
- conversation/session binding;
- routing;
- broker lifecycle/replacement.

Settings route:

- General;
- agents;
- providers;
- tool sets;
- brokers;
- secrets y runtime recovery.

Runner:

- loop básico;
- tools;
- artifacts;
- deferred/concurrency;
- errores/abort;
- observations y steer.

Bootstrap:

- composición base;
- config hot reload;
- degradación/fallos parciales;
- providers/models/memories;
- disposal.

OpenAI:

- model listing;
- request body;
- message mapping;
- streaming;
- errores;
- regresiones de sesión.

Semantic memory:

- extract;
- relevance;
- dream pacing;
- consolidation;
- contradiction;
- search;
- blocks.

La separación debe reutilizar un harness explícito, no copiar el setup en cada archivo nuevo.

---

## TST-011 — Duplicación de assertions que debe conservarse

No toda repetición en tests debe eliminarse.

Conservar:

- autenticación comprobada en cada superficie sensible;
- `Config` probado directamente y a través de HTTP;
- clase base `ChatProvider` y adaptadores concretos;
- invariantes independientes de fold y compact;
- providers falsos con comportamientos diferentes;
- tests por extensión de ownership y contribution IDs;
- pruebas de persistencia en capas donde la persistencia forma parte del contrato.

Un `test.each` puede servir para matrices simples, pero no debe borrar nombres, comentarios o expectativas específicas de seguridad.

---

# Duplicación legítima o falsos positivos descartados

## Catálogos EN/ES

Tienen estructura paralela por diseño. La solución es comprobar paridad, no fusionar ambos idiomas ni generar traducciones.

## `index.ts`

Los archivos barrel repiten nombres exportados, pero no comportamiento. No cuentan como duplicación accidental.

## Fixtures y outputs generados

Copias en `dist`, assets UI, SQL empaquetado o binarios generados no son duplicación de fuente relevante, siempre que sigan ignorados y se reproduzcan desde el build.

## Host service views

`src/services.ts` adapta tokens públicos a tipos concretos del host. No son constantes duplicadas: mantienen identidad del token y estrechan/ensanchan tipos internos deliberadamente.

## Logger público e interno

El logger del kernel añade `setLevel`, mientras el contrato público expone una superficie más limitada. Puede expresarse mediante extensión de interfaz, pero las responsabilidades no son idénticas.

## Storage de memoria frente a disco

Comparten lifecycle, pero sus diferencias de path, migración/import histórico y persistencia son reales. Solo debe extraerse la mecánica común.

## README y deployment

Un quickstart breve duplicado es aceptable para que el README siga siendo autosuficiente.

---

# Verificaciones positivas realizadas

No todo estaba duplicado o divergente. Se comprobó que:

- existen 12 manifests builtin;
- sus IDs, servicios, engines y host packages actuales son coherentes;
- `HOST_PROVIDED_PACKAGES` y `EXTENSION_EXTERNAL_PACKAGES` ya están centralizados en `@nox/extension-api`;
- builds y tests consumen esas listas;
- inglés y español tienen paridad completa en catálogo principal y fragmentos;
- `NOX_VERSION` ya está comprobado contra `package.json` por `src/version.test.ts`;
- CI usa Bun y `bun.lock` de forma consistente;
- la separación UI/kernel está protegida por `src/boundaries.test.ts`;
- los tests ya cuentan con `src/testFixtures.ts` para principal, origin, catálogo y autorización permisiva;
- no se encontraron tests completos claramente copiados de forma exacta entre archivos.

---

# Plan incremental recomendado

## Fase 0 — Baseline y protección del worktree

- [ ] Releer `git status` y clasificar cambios locales por propietario.
- [ ] Ejecutar baseline de tests y guardar fallos preexistentes.
- [ ] No mezclar limpieza con cambios funcionales locales ya en curso.
- [ ] Decidir política de versiones y package manager.

## Fase 1 — Guardas antes de refactorizar

- [ ] Prueba `EXTENSION_API_VERSION` ↔ package version.
- [ ] Prueba `CONFIG_KEYS` ↔ `sections`.
- [ ] Prueba global de manifests builtin.
- [ ] Prueba global de paridad i18n.
- [ ] Prueba/check de versión Bun.
- [ ] Contratos de tipo UI ↔ API pública para Chat y Settings.
- [ ] Cobertura de `displayName`.

## Fase 2 — Divergencias concretas

- [ ] Conservar y mostrar `displayName` en Sessions UI.
- [ ] Alinear opcionalidad de `content` en chat.
- [ ] Alinear validación de URLs con credenciales incrustadas.
- [ ] Eliminar `NOX_SESSION_ID` de docs o implementar la feature.
- [ ] Eliminar/regenerar `package-lock.json` según política.
- [ ] Validar manifests durante `build-extensions`.

## Fase 3 — Fuente canónica pública

- [ ] Migrar contracts de artifacts a `@nox/extension-api`.
- [ ] Consolidar errores/guards de artifacts públicos.
- [ ] Consolidar `stableStringify`.
- [ ] Consolidar `Mutex`.
- [ ] Consolidar `WEB_BROKER_ID`.
- [ ] Centralizar vocabularios de run/tool/config.

## Fase 4 — Settings UI

- [ ] Extraer validaciones compartidas.
- [ ] Extraer funciones puras de managed secrets.
- [ ] Extraer lifecycle form/JSON/dirty/route guard.
- [ ] Migrar ProviderEditor.
- [ ] Migrar ToolSetEditor.
- [ ] Migrar BrokerEditor solo en la parte realmente común.
- [ ] Evaluar AppEditor y AgentEditor después, sin forzar uniformidad.

## Fase 5 — Runtime y storage

- [ ] Extraer helpers de status de runtime.
- [ ] Unificar reconciliación provider/memory.
- [ ] Mantener agentes, brokers y tool sets especializados.
- [ ] Extraer caché/lifecycle común de ExtensionStorageProvider.
- [ ] Evaluar estados async compartidos en stores UI.

## Fase 6 — Infraestructura de tests

- [ ] `TestResources` para temp dirs/database/server.
- [ ] helpers de auth API.
- [ ] app harness UI con MSW auth.
- [ ] manifest real en tests de extensiones.
- [ ] `TEST_CHAT_MODEL` y helpers de providers mínimos.
- [ ] helpers de rechazo.
- [ ] prueba consumidor/productor Sessions.
- [ ] separar suites monolíticas.

## Fase 7 — Documentación y ejemplo

- [ ] Probar build real de greeting-toolset.
- [ ] Revisar snippets/versiones de README y docs.
- [ ] Mantener un único listado canónico de variables de entorno o comprobar docs contra código.

---

# Estrategia de commits sugerida

1. `test: add repository contract guards`
2. `fix(ui): preserve participant display names in session history`
3. `chore: remove stale npm lockfile`
4. `refactor: use public artifact contracts in kernel`
5. `refactor: consolidate core mutex and stable stringify`
6. `refactor(ui): centralize settings validation`
7. `refactor(ui): extract managed secret helpers`
8. `refactor(ui): extract config editor lifecycle`
9. `refactor(runtime): share provider and memory reconciliation`
10. `test: introduce database and api test resources`
11. `test(ui): share authenticated app harness`
12. `test: split monolithic suites by responsibility`
13. `docs: synchronize environment and version guidance`

Cada commit debería dejar verde el área afectada antes de continuar.

---

# Comandos de validación al ejecutar la limpieza

Como mínimo:

```bash
bun run typecheck
bun run lint
bun run format:check
bun run test
bun --cwd=src/ui run type-check
bun --cwd=src/ui run lint
bun --cwd=src/ui run format:check
bun --cwd=src/ui run test:unit
bun --cwd=src/ui run build-only
bun run db:check
bun run build:extensions
bun run build:host
docker compose config >/dev/null
```

O usar los agregados existentes cuando corresponda:

```bash
bun run check
```

`bun run check` no sustituye necesariamente las verificaciones de build de extensiones e imagen que ejecuta CI.

---

# Criterios de terminado

La limpieza se considera terminada cuando:

- un contrato público tiene una única fuente canónica;
- las copias inevitables cuentan con una aserción automática de paridad;
- los manifests reales son los que prueban los tests;
- UI y servidor no pueden cambiar el mismo DTO independientemente sin romper CI;
- los editores comparten lifecycle y validación, pero conservan lógica específica legible;
- provider y memory usan la misma mecánica de reconciliación sin ocultar su creación específica;
- tests nuevos reutilizan resources/harnesses en lugar de copiar cleanup y auth;
- las suites grandes están separadas por responsabilidad;
- la documentación no declara variables o versiones inexistentes;
- no se han perdido las comprobaciones repetidas que protegen fronteras de seguridad.
