# Nox — Dirección de UI

> Documento de exploración del producto y la experiencia de usuario.
> No define implementación ni modifica la definición arquitectónica de
> [NOX.md](NOX.md). Las decisiones técnicas y de alcance continúan perteneciendo
> a ese documento.

## Estado

Dirección conceptual inicial. Aún no se ha comenzado a implementar la UI.

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
Audit
Settings
```

- **Chat:** operación e interacción diaria.
- **Sessions:** conversaciones anteriores y su transcript.
- **Audit:** decisiones de permisos y acciones ejecutadas.
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

El mecanismo de creación de la primera identidad todavía debe definirse.

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
│ Audit        │ Solicitudes de permiso         │ Estado           │
│ Settings     │ Resultados                     │ Detalles sesión  │
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

Desde el chat se puede abrir el registro de auditoría relacionado, pero no se
deben mezclar ambas vistas en un único log ilegible.

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

## Decisiones actuales

- El chat es la pantalla principal.
- Se entra directamente al chat después del login.
- No hay selector de runtimes locales.
- Nox se ejecuta como un sistema containerizado mediante Docker.
- No hay vault planeado ni debe aparecer en la experiencia.
- La navegación primaria propuesta contiene Chat, Sessions, Audit y Settings.
- Toda configuración se concentra en Settings.
- Una sesión pertenece a un agente.
- La actividad de tools se muestra de forma compacta y expandible.
- Las solicitudes de autorización ocurren dentro del chat.
- Sessions y Audit son vistas distintas.

## Preguntas abiertas

- ¿Cómo se crea la primera identidad y qué mecanismo de autenticación se usará?
- ¿Se abre siempre la última sesión o existe una preferencia para comenzar una
  nueva?
- ¿Qué información del reasoning debe exponer la UI y bajo qué modo?
- ¿Cómo se presentan tareas deferred o en segundo plano entre sesiones?
- ¿Qué acento cromático hará reconocible a Nox?
- ¿Qué configuración de provider/model pertenecerá a la aplicación y cuál a cada
  agente o blueprint?
- ¿Cómo se generarán formularios de configuración específicos para
  contribuciones sin imponerles un esquema común incorrecto?
- ¿Cómo se instalarán, verificarán, actualizarán y aislarán extensiones externas
  provenientes de repositorios Git cuando esa maquinaria sea necesaria?
- ¿Qué estados y diagnósticos reales estarán disponibles durante el arranque del
  contenedor y de la Web UI?
