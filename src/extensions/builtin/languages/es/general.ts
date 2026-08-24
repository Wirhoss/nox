const generalMessages = Object.freeze({
  'settings.general.access': 'ACCESO',
  'settings.general.accessTtl': 'TTL del token de acceso (segundos)',
  'settings.general.accessTtlHint': '60–3600 segundos. Valor predeterminado: 900.',
  'settings.general.applicationJson': 'JSON de la aplicación',
  'settings.general.applicationJsonHelp':
    'Acceso al documento completo mediante el mismo esquema que app.json. Al guardar se reemplaza todo el documento; Nox materializa los valores predeterminados.',
  'settings.general.automaticAgent': 'Automático · {agent}',
  'settings.general.bindHost': 'Host de escucha',
  'settings.general.bindHostHint':
    'Usa 127.0.0.1 para acceso exclusivamente local o 0.0.0.0 para todas las interfaces.',
  'settings.general.busyTimeout': 'Tiempo de espera por bloqueo (ms)',
  'settings.general.busyTimeoutHint':
    'Cuánto tiempo espera SQLite cuando hay otro proceso escribiendo.',
  'settings.general.changeRefused': 'Cambio de aplicación rechazado',
  'settings.general.configuredAgents.one': '{count} agente configurado.',
  'settings.general.configuredAgents.other': '{count} agentes configurados.',
  'settings.general.controlPlane': 'PLANO DE CONTROL',
  'settings.general.conversationEntrypoint': 'Punto de entrada de conversaciones',
  'settings.general.conversationEntrypointHelp':
    'Agente asignado a las nuevas conversaciones del navegador. Nox solo puede inferirlo cuando existe exactamente un agente.',
  'settings.general.dataPlane': 'PLANO DE DATOS',
  'settings.general.databasePath': 'Ruta de la base de datos',
  'settings.general.databasePathHint':
    'Ruta absoluta o relativa al directorio de datos configurado.',
  'settings.general.defaultAgent': 'Agente predeterminado',
  'settings.general.diagnostics': 'DIAGNÓSTICO',
  'settings.general.durability.extra': 'Extra',
  'settings.general.durability.full': 'Completa',
  'settings.general.durability.normal': 'Normal',
  'settings.general.durability.off': 'Desactivada',
  'settings.general.durabilityHint':
    'Normal equilibra la durabilidad del WAL y el rendimiento de escritura.',
  'settings.general.durabilityMode': 'Modo de durabilidad',
  'settings.general.httpListener': 'Escucha HTTP',
  'settings.general.httpListenerHelp':
    'Interfaz y puerto que sirven la API autenticada y este panel. Un límite incorrecto puede hacer que el nodo sea inaccesible después de reiniciar.',
  'settings.general.httpPort': 'Puerto HTTP',
  'settings.general.httpPortHint': '0 solicita al sistema operativo un puerto efímero.',
  'settings.general.httpsRequired': 'Se requiere un límite HTTPS',
  'settings.general.httpsRequiredHelp':
    'Los navegadores no devolverán la cookie de renovación mediante HTTP sin cifrar. Actívalo solo si el endpoint público de Nox está protegido con TLS.',
  'settings.general.interface': 'INTERFAZ',
  'settings.general.interfaceLanguage': 'Idioma de la interfaz',
  'settings.general.interfaceLanguageHelp':
    'Idioma predeterminado de esta instalación. La pantalla pública de acceso puede conservar una elección específica del navegador.',
  'settings.general.locale': 'Idioma predeterminado',
  'settings.general.localeHint':
    'Se aplica inmediatamente en este navegador y se usará de forma predeterminada después de reiniciar Nox.',
  'settings.general.logLevel': 'Nivel de registro',
  'settings.general.machineControl': 'CONTROL DE MÁQUINA // APLICACIÓN',
  'settings.general.refreshTtl': 'TTL de la sesión de renovación (segundos)',
  'settings.general.refreshTtlHint': '3600–31536000 segundos. Valor predeterminado: 30 días.',
  'settings.general.runtimeLogging': 'Registro del entorno',
  'settings.general.runtimeLoggingHelp':
    'Gravedad mínima de los eventos que escribe Nox. Los niveles trace y debug pueden exponer metadatos operativos y producir mucha más salida.',
  'settings.general.save': 'Guardar ajustes generales',
  'settings.general.timezone': 'Zona horaria',
  'settings.general.timezoneHint':
    'Zona IANA, como UTC o America/Mexico_City. Los agentes leen en ella la hora de cada mensaje.',
  'settings.general.saved': 'Configuración de la aplicación guardada',
  'settings.general.savedBody':
    'El documento está en disco. Reinicia Nox para aplicar los cambios de la máquina.',
  'settings.general.secureCookies': 'Cookies de renovación seguras',
  'settings.general.secureCookiesHelp': 'Enviar la cookie de renovación solo mediante HTTPS.',
  'settings.general.selectDefaultAgent': 'Selecciona un agente predeterminado',
  'settings.general.sessionSecurity': 'Seguridad de la sesión',
  'settings.general.sessionSecurityHelp':
    'Los tokens de acceso de corta duración autorizan solicitudes; la sesión de renovación mantiene la sesión del operador y puede revocarse.',
  'settings.general.sqliteStorage': 'Almacenamiento SQLite',
  'settings.general.sqliteStorageHelp':
    'Ubicación del estado persistente, margen de contención de bloqueos y política de durabilidad. Las rutas relativas se resuelven dentro del directorio de datos de Nox.',
  'settings.general.validation.configurationObject':
    'La configuración de la aplicación debe ser un único objeto JSON.',
  'settings.general.validation.defaultAgentExists':
    'Elige un agente que exista en el directorio de planos.',
  'settings.general.validation.defaultAgentRequired':
    'Elige el agente que abrirá las nuevas conversaciones web.',
  'settings.general.validation.durabilityMode':
    'Elige un modo de durabilidad de SQLite compatible.',
  'settings.general.validation.hostRequired': 'Se requiere un host de escucha.',
  'settings.general.validation.locale': 'Elige un idioma instalado.',
  'settings.general.validation.timezone':
    'Usa un nombre de zona horaria IANA, como UTC o America/Mexico_City.',
  'settings.general.validation.logLevel': 'Elige un nivel de registro compatible.',
  'settings.general.validation.pathRequired': 'Se requiere una ruta para la base de datos.',
  'settings.general.webChat': 'CHAT WEB',
} as const);

export { generalMessages };
