# Nox — Dirección de UI

> Documento de exploración del producto y la experiencia de usuario.
> Registra la dirección de la Web UI, pero no redefine la arquitectura interna
> del runtime.

## Estado

Dirección conceptual inicial con varios cortes verticales ya implementados. El
flujo de acceso, el chat web en vivo, Settings y Sessions están operativos. Cada
sesión expone por separado su conversación y sus acciones auditadas; no existe
un registro global que mezcle decisiones de sesiones diferentes.

## Visión del producto

Nox es un runtime multiagente, local-first y containerizado. Funciona como un
asistente personal disponible 24/7: conversa con el usuario, utiliza tools,
realiza acciones y conserva un registro de lo ocurrido.

La Web UI será la superficie principal para:

- Conversar con agentes.
- Crear y administrar agentes.
- Consultar sesiones anteriores.
- Revisar acciones y decisiones mediante auditorías.
- Configurar Nox, providers, modelos, tools, tool sets y permisos.
- Configurar brokers.
- Administrar extensiones y, cuando la maquinaria necesaria exista, repositorios
  externos de extensiones.

Nox no debe sentirse como una SaaS corporativa ni como un agente de código. Debe
sentirse como una máquina personal, privada y poco convencional.

## Norte creativo

> Nox no parece una aplicación que descargaste. Parece una máquina secreta que
> encendiste.

Personalidad buscada:

- Street.
- Underground.
- Futurista.
- Rebelde.
- Única.
- Técnica sin resultar hostil.

La referencia a computadoras de los años 80 debe aportar atmósfera, no fricción.
La UI puede parecer una consola clandestina sin obligar al usuario a operar una
terminal real.

## Principios de experiencia

1. **El chat es el centro.** La principal acción después de entrar es hablar con
   un agente.
2. **La estética no puede perjudicar la legibilidad.** Glitches, ruido y efectos
   deben ser escasos y funcionales.
3. **Todo lo administrativo vive en Settings.** La configuración no se reparte
   entre pantallas sin una jerarquía común.
4. **Las acciones son comprensibles.** Antes y después de utilizar una tool, el
   usuario puede entender qué ocurrió.
5. **Toda acción deja una huella.** Las decisiones de gates y las ejecuciones
   deben poder auditarse.
6. **La complejidad técnica se revela por capas.** El resultado humano aparece
   primero; traces, argumentos y eventos internos son expandibles.
7. **Configurar algo no rompe la tarea original.** Si una tool necesita
   configuración, el usuario puede configurarla y volver a la misma conversación.
8. **La UI representa el sistema real.** El arranque y los estados no deben
   inventar subsistemas que Nox no tiene.

## Modelo de navegación

La navegación principal propuesta es deliberadamente pequeña:

```text
Chat
Sessions
Settings
```

- **Chat:** operación e interacción diaria.
- **Sessions:** conversaciones anteriores, su transcript y la auditoría contextual de cada sesión.
- **Settings:** toda la creación, administración y configuración.

No se propone un dashboard obligatorio antes del chat.

## Flujo principal

```text
Docker inicia Nox
        ↓
La Web UI conecta con el runtime
        ↓
Secuencia breve de arranque
        ↓
Inicio de sesión
        ↓
Chat con el agente principal o última sesión
        ↓
El usuario solicita una acción
        ↓
Una tool se prepara y el gate toma una decisión
        ↓
Si hace falta, el usuario autoriza o rechaza
        ↓
Nox ejecuta y presenta el resultado
        ↓
Transcript y auditoría conservan sus registros correspondientes
```

### Arranque

El arranque puede utilizar la estética de una computadora de los años 80, pero
sus estados deben corresponder a verificaciones reales.

```text
NOX // STARTING
──────────────────────
Core runtime....... online
Storage............ online
Extensions......... loaded
Agents............. ready
Web surface........ connected
```

Reglas del arranque:

- Debe ser breve.
- No debe introducir esperas artificiales.
- Debe poder omitirse o reducir movimiento.
- Un error debe producir información útil y acceso a diagnósticos.
- Mientras el runtime no responda, la superficie puede mostrar un estado de
  conexión como `WAITING FOR NOX NODE`.

### Inicio de sesión

Nox es local-first y no se plantea como una SaaS multi-tenant. El login protege
el acceso a la instalación; no debe adoptar innecesariamente el lenguaje de una
plataforma empresarial.

```text
NOX // ACCESS CONTROL

Identity
Password

[ Enter ]
```

La primera identidad reclama la instalación con un código de un solo uso impreso
en los logs del runtime. El código vive únicamente durante el arranque actual y
se invalida al registrar la cuenta o reiniciar Nox. El registro inicia sesión
directamente.

El access token se conserva solo en memoria en la Web UI. La sesión durable se
renueva mediante una cookie HttpOnly emitida por el backend; la UI nunca recibe
el refresh token.

No hay un vault planeado y la UI no debe introducir ese concepto. Las
credenciales requeridas por providers, brokers, extensiones o tools se tratarán
como configuración protegida; su almacenamiento es una decisión técnica
separada.

### Entrada después del login

Después de autenticarse, el usuario entra directamente a:

- La última sesión utilizada, si corresponde; o
- Un chat nuevo con el agente principal.

Puede mostrarse un reporte discreto, sin convertirlo en una pantalla intermedia:

```text
NOX ONLINE

Agent: Nox
Session: New session
Tools: 14 available
```

## Chat

El chat debe dominar visualmente la aplicación.

### Estructura general

```text
┌──────────────┬────────────────────────────────┬──────────────────┐
│ Navegación   │ Conversación                   │ Contexto         │
│              │                                │ opcional         │
│ Chat         │ Mensajes                       │                  │
│ Sessions     │ Tool activity                  │ Agente activo    │
│ Settings     │ Solicitudes de permiso         │ Estado           │
│              │ Resultados                     │ Detalles sesión  │
│              │                                │                  │
│              │ Composer                       │                  │
└──────────────┴────────────────────────────────┴──────────────────┘
```

El panel contextual derecho es opcional y debe poder ocultarse para conservar el
foco.

### Cabecera

La cabecera puede contener:

- Agente activo.
- Título e identidad de la sesión.
- Estado: idle, ejecutando, esperando autorización o detenido.
- Ocupación del contexto como dona, basada en el conteo canónico del runtime.
- Acciones de la sesión.
- Acceso al contexto técnico.

### Mensajes y actividad técnica

La respuesta humana tiene prioridad. Tool calls, resultados, retries, fold y
compaction deben aparecer como eventos compactos y expandibles cuando resulte
útil mostrarlos.

```text
YOU
Revisa mis correos importantes.

NOX
Voy a consultar los mensajes recibidos durante las últimas 24 horas.

┌ TOOL ACTIVITY ─────────────────────┐
│ search_email                       │
│ 42 messages retrieved             │
│ Completed in 1.4s                 │
│                          [Details] │
└────────────────────────────────────┘

NOX
Encontré cuatro mensajes que requieren atención...
```

La conversación no debe llenarse de logs. Los detalles técnicos son una segunda
capa.

### Composer

El composer podrá contemplar:

- Texto.
- Archivos e imágenes.
- Identidad visible del agente activo.
- Envío y detención de una ejecución.
- Comandos rápidos si demuestran ser útiles.
- Estado de trabajo en segundo plano.

```text
┌──────────────────────────────────────────┐
│ Tell Nox what needs to be done...        │
│                                          │
│ [+] Attach   [Agent: Nox]     [Execute]  │
└──────────────────────────────────────────┘
```

## Agentes y sesiones

El modelo inicial respeta la arquitectura actual:

```text
Una sesión → Un agente
```

Al crear una sesión, el agente principal puede seleccionarse automáticamente. El
usuario puede abrir el selector para elegir otro:

```text
NEW SESSION

● Nox             Personal assistant
○ Mailroom        Email specialist
○ Watcher         Monitoring

[ Start session ]
```

No se propone inicialmente que varios agentes hablen dentro del mismo chat. Las
experiencias multiagente compuestas pertenecen mejor al concepto futuro de Apps.

Un agente sí puede sugerir continuar con otro:

```text
Watcher está mejor equipado para esta tarea.

[ Open session with Watcher ] [ Continue here ]
```

Esto crea otra sesión en lugar de alterar silenciosamente la identidad del agente
actual.

## Tools, gates y autorizaciones

Cuando una acción requiere aprobación, la solicitud aparece dentro del contexto
de la conversación.

```text
PERMISSION REQUIRED

Tool: send_email
Agent: Nox
Resource: maria@example.com
Effect: External communication
Reversible: No

Nox quiere enviar:
“Confirmo nuestra reunión del viernes…”

[ Deny ] [ Approve once ] [ Approve for session ]
```

Los alcances iniciales coinciden con el comportamiento actual de los gates:

- Aprobar una vez.
- Aprobar durante la sesión activa.

La tarjeta debe explicar, cuando exista esa información:

- Tool solicitada.
- Agente y sesión.
- Argumentos importantes en lenguaje comprensible.
- Recursos afectados.
- Efectos y reversibilidad.
- Riesgos detectados.
- Motivo por el que se solicita autorización.

Después de ejecutar:

```text
MESSAGE SENT

Recipient: maria@example.com
Completed: 22:41:08
Decision: Approved by user
Audit: #A81F
```

## Configuración requerida durante una conversación

Si una tool no puede ejecutarse porque le falta configuración, el chat presenta
el bloqueo sin intentar convertirse en un formulario administrativo.

```text
CONFIGURATION REQUIRED

send_email cannot run because its provider
has not been configured.

[ Open tool settings ]
```

El botón lleva a la página exacta dentro de Settings. La interfaz conserva el
origen de navegación para ofrecer:

```text
Tool configured successfully

[ Return to session ]
```

Al regresar, Nox pregunta si debe continuar. No se ejecuta automáticamente una
acción pendiente sin confirmación.

## Settings

Settings es una sección completa, no un modal pequeño. Estructura conceptual:

```text
Settings
├── General
├── Interface
├── Agents
├── Providers & Models
├── Tools
├── Tool Sets
├── Permissions / Gates
├── Brokers
├── Extensions
│   ├── Installed
│   ├── Repositories
│   └── Updates
├── Storage
└── Diagnostics
```

La estructura definitiva evolucionará cuando cada contribución tenga un segundo
consumidor real y sus necesidades de configuración sean conocidas.

### Configuración de una tool

Una tool puede necesitar su propia configuración. Su página podrá mostrar:

- Nombre, descripción e identidad estable.
- Extensión que la aporta.
- Tool set al que pertenece.
- Estado: disponible, incompleta, desactivada o con error.
- Campos de configuración específicos.
- Provider o broker relacionado.
- Efectos, recursos, volumen y reversibilidad declarados.
- Agentes que tienen acceso.
- Política de gates aplicable.
- Prueba de funcionamiento.
- Logs recientes.

La configuración debe ser extensible: Nox no puede asumir que todas las tools
comparten los mismos campos.

## Modelo mental de capacidades

- **Extension:** unidad empaquetada con ciclo de vida que aporta una o varias
  contribuciones.
- **Contribution:** capacidad concreta registrada en un contribution point.
- **Tool:** capacidad determinista que el modelo puede llamar.
- **Tool set:** grupo nombrado de tools que puede concederse a un agente.
- **Provider:** adaptador a una API de modelos.
- **Broker:** transporte hacia un gateway de mensajes, por ejemplo Discord o
  WhatsApp.
- **Agent:** instancia viva de una definición o blueprint.
- **Session:** conversación de un agente, compuesta por transcript y contexto
  activo.
- **Gate:** decisión de permiso sobre una llamada a una tool.

El flujo futuro de extensiones externas se imagina así:

```text
Repositorio Git
      ↓
Instalar extensión
      ↓
Registrar contribuciones y tools
      ↓
Configurar lo que cada contribución necesite
      ↓
Asignar capacidades y permisos
      ↓
Utilizar desde un agente
```

La distribución de extensiones externas, su aislamiento y la maquinaria de carga
continúan diferidos en la arquitectura actual; esta sección describe dirección
de producto, no alcance inmediato.

## Sessions y Audit

Son fuentes de información relacionadas, pero distintas.

### Sessions

Responden: **¿qué ocurrió en esta conversación?**

- Mensajes del usuario y del asistente.
- Tool calls y tool responses.
- Eventos técnicos expandibles.
- Transcript permanente y completo.
- Contexto activo como representación derivada, no como sustituto del historial.

### Audit

Responde: **¿por qué y con qué autorización se permitió o rechazó una acción?**

- Tool solicitada.
- Agente y sesión.
- Recurso y efecto.
- Señales de riesgo.
- Regla o evaluador que decidió.
- Veredicto del gate.
- Resolución humana, si existió.
- Alcance de la aprobación.
- Momento y resultado.

Son proyecciones distintas dentro de una sesión seleccionada: **Conversación** y
**Auditoría** se presentan como pestañas, no como un único log ni como un ledger
global. Auditoría agrupa authorization, Gate, resolución humana y todas las
respuestas de la tool por acción ejecutada (`trackId`), incluyendo contenido,
errores y referencias a artefactos, evitando mostrar etapas internas como
acciones duplicadas.

## Dirección visual inicial

### Color

- Negro carbón como base, evitando negro puro en todas las superficies.
- Grises metálicos.
- Verde fósforo o ámbar como color operativo.
- Un acento rebelde secundario por definir: rojo señal, violeta eléctrico o azul
  ultravioleta.
- Textura y ruido muy sutiles.

### Tipografía

- Monoespaciada con personalidad para títulos, etiquetas y metadata.
- Tipografía altamente legible para conversaciones largas.
- Mayúsculas reservadas para estados y etiquetas del sistema.

### Movimiento

- Cursor, escaneo e interferencias solamente cuando comuniquen actividad.
- Nada de glitches constantes.
- Respetar reducción de movimiento.
- Animaciones asociadas a conectar, pensar, ejecutar, esperar o completar.

La meta no es “cyberpunk genérico”. La mezcla buscada es:

> Terminal ochentera + hardware clandestino + interfaz futurista funcional.

## Stack tecnológico de la Web UI

La UI debe conservar la libertad visual de Nox sin sacrificar accesibilidad,
legibilidad, organización ni límites arquitectónicos.

| Área | Decisión inicial |
|---|---|
| Framework | Vue 3 |
| Lenguaje | TypeScript estricto |
| Componentes | Vue Single File Components |
| Build | Vite, ejecutado con Bun |
| Estado | Pinia |
| Navegación | Vue Router |
| Estilos | SCSS scoped/modules + CSS Custom Properties |
| Primitivos accesibles | Reka UI, sin estilos visuales |
| Formularios | VeeValidate + Zod |
| Superficie HTTP | Hono sobre Bun, sujeto al diseño del contrato de superficie |
| Tiempo real | HTTP para comandos + Server-Sent Events para eventos y streaming |
| Tests unitarios | Vitest + Vue Testing Library |
| Mocks de API | MSW |
| Tests end-to-end | Playwright |
| Calidad | ESLint + Prettier + Stylelint |

React, JSX y frameworks construidos alrededor de React quedan explícitamente
fuera del stack de Nox.

### Vue y Vite

Vue permite componentes legibles con template, lógica tipada y estilos
co-localizados. Vite proporciona un build de cliente pequeño y directo, sin
introducir capacidades de SSR o SEO que una aplicación local servida desde
Docker no necesita.

No se propone Next.js, Tailwind, Redux, GraphQL, Electron, Tauri,
microfrontends ni un design system empaquetado por separado antes de que exista
un segundo consumidor real.

### Organización del código

La Web UI vive en `src/ui/` como un workspace aislado dentro del único árbol
`src/`. La frontera evita que Vue entre al kernel y prohíbe que la UI importe
sus clases internas. Su estructura conceptual será:

```text
src/ui/
├── app/
│   ├── App.vue
│   ├── router.ts
│   └── bootstrap.ts
├── routes/
├── features/
│   ├── chat/
│   ├── sessions/
│   ├── permissions/
│   ├── audit/
│   └── settings/
├── shared/
│   ├── api/
│   ├── lib/
│   ├── ui/
│   └── styles/
└── assets/
```

Los stores, componentes y composables que pertenecen a una feature permanecen
junto a ella. Solo se mueven a `shared/` cuando tienen un segundo consumidor
real. Se evitarán carpetas globales de `utils`, `hooks` o `components` sin un
dominio claro.

### Capas de componentes

1. **Primitives:** Button, TextField, Dialog, Select, Tabs, Tooltip, Panel.
2. **Patterns:** SystemStatus, EmptyState, SettingsField, EventCard.
3. **Domain components:** ChatMessage, ToolActivityCard,
   PermissionRequestCard, AuditDecisionCard.
4. **Features:** ChatTimeline, AgentEditor, AuditExplorer, ExtensionManager.

Los primitives no conocen features. Las features pueden componer primitives y
patterns. Un componente no debe convertirse en universal mediante decenas de
props booleanas.

Cada componente reutilizable puede mantener juntos sus archivos relevantes:

```text
PermissionRequest/
├── PermissionRequest.vue
├── PermissionRequest.vitest.ts
├── PermissionRequest.stories.ts
└── index.ts
```

## Arquitectura de estado con Pinia

Pinia será el sistema oficial de estado de la Web UI. Inicialmente no se añadirá
una segunda cache como TanStack Query: si las necesidades reales de caching,
deduplicación o invalidación lo justifican, se reconsiderará entonces.

El flujo de datos esperado es:

```text
HTTP / SSE
    ↓
API client
    ↓
Validación del DTO
    ↓
Pinia action
    ↓
Estado normalizado
    ↓
Getters
    ↓
Componentes Vue
```

Los componentes no realizan `fetch` ni interpretan eventos crudos directamente.
Nox continúa siendo la fuente de verdad; Pinia conserva una proyección de ese
estado para la interfaz.

### Propiedad del estado

- **Vue Router:** sesión seleccionada, sección de Settings, filtros y cualquier
  estado que deba tener una URL recuperable.
- **Pinia:** datos del runtime, estado compartido de la aplicación, proyecciones
  de eventos y preferencias globales.
- **Estado local del componente:** hover, tooltip, expansión y valores efímeros
  que no necesitan sobrevivir al componente.

No se debe duplicar en Pinia información que ya puede derivarse de la ruta o de
otro valor canónico.

### Stores iniciales

```text
app/stores/
├── auth.store.ts
├── runtime.store.ts
├── preferences.store.ts
├── theme.store.ts
└── notifications.store.ts

features/chat/stores/
├── sessions.store.ts
├── activeSession.store.ts
└── composer.store.ts

features/permissions/stores/
└── permissions.store.ts
```

Los demás dominios, como agents, audit, tools, brokers y extensions, tendrán un
store dentro de su feature cuando lo necesiten. No existirá un único
`useAppStore` dueño de toda la aplicación.

`permissions.store` es transversal porque una solicitud de autorización puede
provenir de una sesión que no esté visible. `activeSession.store` es responsable
del stream, la ejecución actual y la ventana cargada del transcript.

### Estados explícitos

Los procesos asíncronos se representan mediante uniones discriminadas, no con
varios booleanos que puedan contradecirse.

```ts
type RunStatus =
  | { type: 'idle' }
  | { type: 'submitting'; clientMessageId: string }
  | { type: 'running'; runId: string }
  | { type: 'waiting-permission'; requestId: string }
  | { type: 'stopping'; runId: string }
  | { type: 'failed'; error: NoxError };
```

### Eventos y sesiones largas

Los eventos SSE se validan, deduplican y aplican mediante una única action. Los
componentes no escuchan el stream por separado.

```text
SSE event → validar → deduplicar → applyEvent(event) → actualizar stores
```

Las sesiones pueden contener cientos de turnos. El listado de sesiones conserva
solo resúmenes y metadata; el store de la sesión activa mantiene una ventana
paginada del transcript y los eventos nuevos. Los mensajes se identifican por
`messageId` para evitar duplicados después de una reconexión.

### Persistencia local

La persistencia es explícita y por allowlist. Puede incluir tema, densidad,
reducción de movimiento y estado de paneles. No debe persistir globalmente:

- Credenciales o tokens.
- Transcripts completos.
- Solicitudes de permiso.
- Resultados sensibles de tools.
- Configuración secreta.

### Reglas de Pinia

1. Cada store representa un dominio concreto.
2. Las llamadas HTTP viven en clientes API tipados.
3. Los componentes llaman actions y no conocen endpoints.
4. Los getters no producen efectos secundarios.
5. Los eventos en tiempo real entran por un único punto.
6. No se duplica información derivable.
7. Se evitan dependencias circulares entre stores.
8. Solo se persisten campos autorizados expresamente.
9. Stores y transiciones se prueban sin montar toda la aplicación.

## Contrato HTTP y tiempo real

HTTP JSON maneja comandos y un stream SSE autenticado entrega lo que el web
broker renderiza. El contrato implementado actualmente es:

```text
GET  /api/chat/commands
GET  /api/chat/conversations
GET  /api/chat/conversations/:conversationId/history
GET  /api/chat/stream
POST /api/chat/conversations/:conversationId/messages
POST /api/chat/conversations/:conversationId/steer
POST /api/chat/conversations/:conversationId/commands/:command
POST /api/chat/conversations/:conversationId/permissions/:requestId
```

El cliente genera `conversationId`; la conversación se materializa en el
runtime con su primer mensaje. El stream es único para todas las conversaciones
y cada evento declara a cuál pertenece. Transporta fragmentos, mensajes
asentados, actividad técnica, ciclo de vida de runs, permisos y el estado del
contexto. El conteo de contexto se calcula dentro del runtime, se calibra con el
provider cuando este informa usage y nunca se estima de nuevo en el navegador.

La UI abre la conversación más reciente, reconstruye el transcript, permite
cambiar o comenzar una conversación, enviar steering durante un run e invocar
el catálogo dinámico de comandos. WebSocket se añadirá únicamente si aparece un
requisito bidireccional que HTTP + SSE no pueda resolver correctamente.

La UI no importa clases internas como `Session`, `Agent` o `SessionGate`:

```text
Kernel objects → HTTP surface → API DTOs → Web UI
```

Todo DTO recibido se valida antes de entrar a Pinia.

## Estilos y temas custom

SCSS y CSS Custom Properties tienen responsabilidades diferentes:

- **SCSS:** estructura, responsive, estados, mixins y estilos locales.
- **CSS variables:** design tokens, temas y valores modificables en runtime.

Los componentes no escriben colores visuales directamente y no asumen que el
tema siempre será oscuro.

```scss
.message {
  color: var(--nox-text-primary);
  background: var(--nox-surface-message);
  border: 1px solid var(--nox-border-subtle);
  border-radius: var(--nox-radius-message);
}
```

### Organización de SCSS

```text
shared/styles/
├── tokens/
│   ├── _colors.scss
│   ├── _spacing.scss
│   ├── _typography.scss
│   ├── _motion.scss
│   └── _layers.scss
├── themes/
├── base/
├── mixins/
└── global.scss
```

Reglas iniciales:

- No escribir colores o medidas temáticas directamente en componentes.
- Limitar la anidación de selectores.
- Evitar `!important` y `@extend`.
- No depender de una estructura DOM distante.
- Limitar estilos globales a tokens, temas, reset, fuentes y documento.
- Usar scoped SCSS o SCSS Modules de forma consistente según la categoría del
  componente; la convención definitiva se cerrará antes de implementar.

### Contrato de tema

Los temas reemplazan tokens semánticos, no detalles internos del DOM:

```text
--nox-canvas
--nox-surface-1
--nox-text-primary
--nox-text-muted
--nox-border-subtle
--nox-action-primary
--nox-focus-ring
--nox-status-success
--nox-status-warning
--nox-status-danger
--nox-font-interface
--nox-font-content
--nox-font-mono
--nox-radius-control
--nox-glow-strength
--nox-noise-opacity
--nox-scanline-opacity
```

Los nombres describen función, no un color concreto. Cada variable tiene un
fallback seguro en el tema base.

### Temas oficiales y custom

Nox podrá incluir temas oficiales y permitir:

- Seleccionar e instalar temas.
- Editar tokens mediante Settings.
- Previsualizar antes de aplicar.
- Importar y exportar un tema declarativo.
- Instalar temas desde repositorios cuando exista la maquinaria correspondiente.
- Revertir automáticamente una preview ilegible.

Un tema custom será inicialmente datos y assets, no JavaScript, Vue ni CSS
arbitrario:

```text
Theme package
├── theme.json
├── preview.webp
├── fonts/
└── assets/
```

Su manifest podrá declarar identidad, autor, versión, compatibilidad con Nox,
apariencia y tokens. Nox validará valores permitidos, tokens desconocidos,
contraste, tamaño y procedencia de assets, tipografías y compatibilidad.

Un tema no puede ocultar controles de autorización, focus rings, errores
críticos, identidad del agente, tool solicitada ni recursos afectados. Las
preferencias de accesibilidad —reducción de movimiento, contraste y tamaño de
texto— tienen prioridad sobre el tema.

No se permitirá inicialmente que un tema o extensión externa inyecte React, Vue,
JavaScript o CSS arbitrario en la interfaz. Una UI custom ejecutable requeriría
un modelo explícito de aislamiento, seguridad y compatibilidad.

### Configuración dinámica

Las contribuciones pueden requerir configuraciones diferentes. La dirección
inicial es que el servidor entregue un descriptor serializable, la UI lo renderice
con fields compartidos y el servidor valide nuevamente al guardar. Los
formularios declarativos son preferibles a permitir que una extensión ejecute su
propia UI.

## Estrategia de pruebas de UI

- **Vitest + Vue Testing Library:** comportamiento, estados, teclado y
  accesibilidad de componentes y stores.
- **MSW:** contratos de API durante desarrollo y tests.
- **Playwright:** login, chat, streaming, permisos, configuración y auditoría.
- **Storybook para Vue o Histoire:** se evaluará cuando existan los primeros
  primitives; no se añadirá antes de tener componentes que documentar.
- **Stylelint:** consistencia y restricciones de SCSS.

Los componentes críticos se probarán al menos con el tema principal, un tema
alternativo y alto contraste.

## Decisiones actuales

- El chat es la pantalla principal.
- Se entra directamente al chat después del login.
- No hay selector de runtimes locales.
- Nox se ejecuta como un sistema containerizado mediante Docker.
- No hay vault planeado ni debe aparecer en la experiencia.
- La navegación primaria propuesta contiene Chat, Sessions y Settings.
- Toda configuración se concentra en Settings.
- Una sesión pertenece a un agente.
- La actividad de tools se muestra de forma compacta y expandible.
- Las solicitudes de autorización ocurren dentro del chat.
- Conversación y Auditoría son pestañas distintas dentro de una sesión.
- Vue 3, TypeScript, Vite y Pinia forman la base de la Web UI.
- React y JSX no forman parte del stack.
- SCSS y CSS Custom Properties sostienen el sistema visual y los temas.
- Los temas custom son inicialmente declarativos y no ejecutan código.
- HTTP maneja comandos y SSE maneja streaming y eventos, salvo que un requisito
  futuro justifique WebSocket.
- Pinia mantiene la proyección de estado de la UI sin sustituir a Nox como fuente
  de verdad.
- La primera identidad reclama Nox con un código efímero impreso por el runtime.
- El access token vive solo en memoria y la renovación utiliza una cookie HttpOnly.

## Casos especiales de la UI

Inventario de los lugares donde la Web UI decide por un nombre en duro algo que el
runtime ya declara. Ninguno es un accidente aislado: todos son la misma forma —
la UI adivinando desde un identificador en vez de leer una contribución— y cada
uno deja de funcionar en cuanto aparece una segunda contribución del mismo tipo.

### 1. `isWeb` en `BrokerEditor`

```ts
const isWeb = computed(() => common.value.type === 'web' && props.entryId === 'web')
```

Ese string decide en doce lugares si el agente es obligatorio, si se validan y se
dibujan las concesiones, y si la entrada puede borrarse.

El kernel ya lo declara: `BrokerHostPolicy` tiene `authorization: 'grants' | 'owner'`
y `selectableAgent`. El broker web no tiene concesiones porque su autoridad es la
del dueño, y su agente es opcional porque es seleccionable — no porque se llame
`web`. **Un broker de tercero que declare `authorization: 'owner'` recibe hoy un
editor de concesiones que no debe tener.** Lo cierra que `ConfigTypeSchemaDescriptor`
lleve el `host` de la contribución.

### 2. El nombre reservado `web`, validado dos veces

`BrokerEditor` rechaza a mano el ID `web` al crear. Desde que una contribución de
instancia única es dueña de su propio nombre, la sección lo rechaza sola al
validar. La UI mantiene una copia de una regla que ya no le pertenece, escrita
con el nombre en duro.

### 3. `openai_completions` en `ProviderEditor`

Cuatro usos: si se dibuja formulario o JSON crudo, qué plantilla trae una entrada
nueva, y qué se ofrece en el selector de tipo. **Cualquier otro adaptador de
provider cae a JSON crudo aunque contribuya un esquema perfectamente
renderizable.** `ProviderEditor` es el único editor de sección contribuida que no
consume `contributionTypes`: `ToolSetEditor` ya resuelve esto mirando si existe un
descriptor para el tipo.

### 4. `AUTHORITY_SUGGESTIONS`, y es el peor

`BrokerEditor` sugiere ocho autoridades escritas a mano. Cuatro de ellas —
`nox.history.*`, `nox.history.read`, `nox.history.search`, `nox.tools.search` —
**no las registra ninguna extensión**: solo aparecen en archivos de test. Una
concesión escrita con cualquiera de ellas no puede coincidir con nada, porque
`authorize()` rechaza toda autoridad que nadie registró.

Al mismo tiempo, las que sí existen no se ofrecen: las tres del tool set de
configuración, las tres de tareas programadas, las cinco del tool set web y la del
comando de sesión. `authorities` es un punto de contribución con descripción por
autoridad; la lista tiene que venir de ahí y no de una constante.

### 5. `approvers` en `COMMON_PROPERTIES`

`BrokerEditor` excluye `approvers` del payload del transporte. Ese campo fue
eliminado del esquema de brokers: la UI sigue enmarcando vocabulario que ya no
existe.

### 6. `switch (props.section.key)` en `ConfigEntryList`

La línea de resumen de cada fila está escrita a mano por sección — proveedor y
modelo para un blueprint, tipo y agente para un broker— y la descripción adivina
entre `description` y `baseUrl`. Una sección contribuida nueva cae al texto
genérico. Es metadato que corresponde al esquema o al descriptor del tipo.

### 7. `SETTINGS_SECTIONS` duplica el catálogo

La UI mantiene su propia tabla de secciones — clave, slug, grupo, etiquetas y
`creatable` — mientras el catálogo del control plane ya enumera las secciones con
su forma. `creatable` en particular resultó incorrecto: bloqueaba configurar una
contribución que la propia lista estaba ofreciendo.

### 8. El despacho por sección en `SettingsRoute`

Cinco `v-else-if` sobre `section?.key` eligen entre cinco editores a medida. Es la
consecuencia estructural de todo lo anterior más que una decisión propia: mientras
cada sección necesite su componente, la ruta tiene que nombrarlas.

### 9. `createId('web')` en el store de chat

La superficie del navegador arma sus IDs de conversación con el ID del broker en
duro. Es defendible —esa superficie *es* el broker web— pero el kernel exporta
`WEB_BROKER_ID` justamente para que no haya un literal suelto.

### 10. El centinela `NEW_SECRET`

`'__new_secret__'` está definido dos veces, en `ProviderEditor` y en
`SchemaFieldGroup`. Dos copias de un valor que solo significa algo si ambas
coinciden.

## Archivos que conviene separar

Cinco archivos concentran la mitad de la UI. El tamaño importa menos que la razón:
todos crecieron por acumular a mano lo que un esquema ya describe.

| Archivo | Líneas | script / template / estilos |
|---|---|---|
| `settings/components/AgentEditor.vue` | 2117 | 762 / 642 / 713 |
| `settings/components/BrokerEditor.vue` | 1797 | 790 / 503 / 504 |
| `settings/components/ProviderEditor.vue` | 1567 | 638 / 433 / 496 |
| `chat/stores/activeSession.store.ts` | 1246 | — |
| `settings/components/AppEditor.vue` | 1104 | 411 / 349 / 344 |
| `settings/components/ToolSetEditor.vue` | 1087 | 500 / 218 / 369 |

Las costuras, en orden de lo que más devuelve:

- **Los campos contribuidos salen del esquema.** `SchemaFieldGroup` ya existe y
  `ToolSetEditor` ya lo usa. `BrokerEditor` y `ProviderEditor` mantienen en su
  lugar un `textarea` de JSON con su propio parseo, formateo y validación, y
  `BrokerEditor` además un mecanismo de secretos paralelo al que el grupo de campos
  ya trae. Es la mayor parte de lo que se puede borrar.
- **El armazón de editor es uno solo.** Los cuatro editores repiten la misma
  forma: borrador, modo JSON, ID de entrada, secretos pendientes, guardado,
  bloqueo de navegación con cambios sin guardar. Eso es un composable, no cuatro
  copias.
- **Concesiones y conversaciones son un componente.** Son vocabulario del kernel
  igual para todo broker, y la única parte donde el formulario a mano se gana el
  lugar: una autoridad mal escrita es un agujero de permisos, y ahí conviene un
  editor que sepa qué es una autoridad. Pero vive por su cuenta.
- **Los estilos son un sistema, no cinco.** Unas 2400 líneas de SCSS con alcance
  local repiten el mismo lenguaje visual de secciones, campos y avisos.
- **`activeSession.store` tiene tres trabajos**: construir la línea de tiempo,
  hablar con el transporte y seguir el estado de la ejecución en curso.

## Preguntas abiertas
- ¿Se abre siempre la última sesión o existe una preferencia para comenzar una
  nueva?
- ¿Qué información del reasoning debe exponer la UI y bajo qué modo?
- ¿Cómo se presentan tareas deferred o en segundo plano entre sesiones?
- ¿Qué acento cromático hará reconocible a Nox?
- ¿Qué temas oficiales acompañarán el primer release de la Web UI?
- ¿Se usará scoped SCSS, SCSS Modules o una convención híbrida y estrictamente
  definida?
- ¿Qué configuración de provider/model pertenecerá a la aplicación y cuál a cada
  agente o blueprint?
- ¿Cómo se generarán formularios de configuración específicos para
  contribuciones sin imponerles un esquema común incorrecto?
- ¿Cómo se instalarán, verificarán, actualizarán y aislarán extensiones externas
  provenientes de repositorios Git cuando esa maquinaria sea necesaria?
- ¿Qué estados y diagnósticos reales estarán disponibles durante el arranque del
  contenedor y de la Web UI?
- ¿La superficie HTTP que sirve la UI vivirá como builtin contribution o como otra clase de
  superficie concreta alrededor de `NoxApplication`?
