const agentMessages = Object.freeze({
  'settings.agent.actionPolicy': 'Política de acciones',
  'settings.agent.actionPolicyHelp':
    'Sobrescribe la puerta de ejecución para este agente. Las reglas de coincidencia de parámetros siguen disponibles en el modo JSON.',
  'settings.agent.allTools': 'Todas las herramientas',
  'settings.agent.blueprintJson': 'JSON del plano',
  'settings.agent.blueprintJsonHelp':
    'Acceso completo a reglas de la puerta, listas de herramientas permitidas y campos sin un control específico. Al guardar se reemplaza todo el plano.',
  'settings.agent.capabilities': 'CAPACIDADES',
  'settings.agent.changeRefused': 'Cambio de agente rechazado',
  'settings.agent.compactRatio': 'Compactar en la proporción',
  'settings.agent.contextPressure': 'Presión de contexto',
  'settings.agent.contextWindow': 'Ventana de contexto',
  'settings.agent.customGate': 'Usar una política de puerta personalizada',
  'settings.agent.defaultVerdict': 'Veredicto predeterminado',
  'settings.agent.description': 'Descripción',
  'settings.agent.descriptionHint':
    'Se muestra al elegir un agente. No forma parte del prompt del sistema.',
  'settings.agent.descriptionPlaceholder': 'Asistente personal',
  'settings.agent.direct': 'Directas',
  'settings.agent.directive': 'DIRECTIVA',
  'settings.agent.escalationTimeout': 'Tiempo límite de escalado (ms)',
  'settings.agent.frequencyPenalty': 'Penalización de frecuencia',
  'settings.agent.generation': 'Generación',
  'settings.agent.generationContext': 'Generación y contexto',
  'settings.agent.generationContextHelp':
    'Controles opcionales de muestreo del proveedor y presión de contexto.',
  'settings.agent.grantScope': 'Ámbito de concesión de {toolSet} en {channel}',
  'settings.agent.grantedCount': '{count} CONCEDIDAS',
  'settings.agent.header': 'PLANO DEL AGENTE',
  'settings.agent.id': 'ID del agente',
  'settings.agent.idHint':
    'Identidad estable usada por conversaciones, referencias de configuración y el archivo del plano.',
  'settings.agent.identity': 'IDENTIDAD',
  'settings.agent.identityModel': 'Identidad y modelo',
  'settings.agent.identityModelHelp':
    'El modelo que gestiona la conversación y la descripción visible para el operador.',
  'settings.agent.internalTasks': 'TAREAS INTERNAS',
  'settings.agent.inventoryUnavailable':
    'El inventario de herramientas del entorno no está disponible. Las concesiones de conjuntos completos siguen siendo editables; usa JSON para conservar una lista permitida desconocida.',
  'settings.agent.maxIterations': 'Iteraciones máximas',
  'settings.agent.maxIterationsHint':
    'Máximo de iteraciones del bucle modelo/herramienta, o «sin límite».',
  'settings.agent.maxPendingPermissions': 'Máximo de permisos pendientes',
  'settings.agent.maxTokens': 'Tokens máximos',
  'settings.agent.memory': 'Memoria a largo plazo',
  'settings.agent.memoryDisabled': 'Sin memoria a largo plazo',
  'settings.agent.memoryHint':
    'Selecciona como máximo una memoria configurada. El almacenamiento siempre se aísla por el ID de este agente.',
  'settings.agent.memoryMaxTokens': 'Presupuesto de tokens de memoria',
  'settings.agent.memoryMaxTokensHint':
    'Máximo de memoria recuperada que se inyecta de forma efímera en cada ejecución del modelo.',
  'settings.agent.model': 'Modelo',
  'settings.agent.modelContext': 'CONTEXTO DEL MODELO',
  'settings.agent.modelHint': 'ID exacto del modelo expuesto por el proveedor seleccionado.',
  'settings.agent.modelOverride': 'Modelo alternativo',
  'settings.agent.moveFrom': 'MOVER DESDE {channel}',
  'settings.agent.noChannelCapabilities.direct':
    'No hay capacidades directas. Usa + Añadir para conceder una.',
  'settings.agent.noChannelCapabilities.routed':
    'No hay capacidades enrutadas. Usa + Añadir para conceder una.',
  'settings.agent.noMatchingToolSets': 'No hay conjuntos de herramientas coincidentes.',
  'settings.agent.noToolSetsConfigured':
    'Las extensiones activas no tienen configurado ningún conjunto de herramientas.',
  'settings.agent.noToolsMatch': 'Ninguna herramienta coincide con esta búsqueda.',
  'settings.agent.onDemandRouter': 'ENRUTADOR BAJO DEMANDA',
  'settings.agent.openGateJson': 'Abrir JSON de la puerta',
  'settings.agent.permissionGate': 'PUERTA DE PERMISOS',
  'settings.agent.presencePenalty': 'Penalización de presencia',
  'settings.agent.preservedAllowlist': 'Conservado de la lista permitida configurada.',
  'settings.agent.provider': 'Proveedor',
  'settings.agent.providerOverride': 'Proveedor alternativo',
  'settings.agent.remove': 'Eliminar agente',
  'settings.agent.removeQuestion': '¿Eliminar el plano del agente?',
  'settings.agent.removeToolSet': 'Eliminar {toolSet} de {channel}',
  'settings.agent.removeWarning':
    'Nox rechazará la eliminación mientras un bróker activo todavía enrute hacia este agente.',
  'settings.agent.reserveOutput': 'Reservar para la salida',
  'settings.agent.riskHeuristics': 'Activar heurísticas de riesgo',
  'settings.agent.routed': 'Enrutadas',
  'settings.agent.rules.one': '{count} REGLA',
  'settings.agent.rules.other': '{count} REGLAS',
  'settings.agent.rulesHelp':
    'Las reglas de coincidencia de herramienta, conjunto y parámetros pueden revisarse en modo JSON.',
  'settings.agent.runtimeTuning': 'AJUSTE DEL ENTORNO',
  'settings.agent.save': 'Guardar agente',
  'settings.agent.saved': 'Plano del agente guardado',
  'settings.agent.searchToolSets': 'Buscar conjuntos de herramientas configurados',
  'settings.agent.searchToolSetsPlaceholder': 'Nombre, tipo o descripción',
  'settings.agent.searchTools': 'Buscar herramientas',
  'settings.agent.searchToolsIn': 'Buscar herramientas en {toolSet} para {channel}',
  'settings.agent.selectProvider': 'Selecciona un proveedor',
  'settings.agent.selectedTools': 'Herramientas seleccionadas',
  'settings.agent.systemPrompt': 'Prompt del sistema',
  'settings.agent.systemPromptHelp':
    'La instrucción permanente aplicada antes de cada conversación con este agente.',
  'settings.agent.systemPromptPlaceholder': 'Eres...',
  'settings.agent.task.compaction': 'Compactación',
  'settings.agent.task.title': 'Título',
  'settings.agent.taskOverrides': 'Modelos alternativos para tareas',
  'settings.agent.taskOverridesHelp':
    'Déjalos vacíos para usar el proveedor y el modelo de la conversación.',
  'settings.agent.temperature': 'Temperatura',
  'settings.agent.titleFallback': 'Agente',
  'settings.agent.titleNew': 'Nuevo agente',
  'settings.agent.toolSetGrants': 'Concesiones de conjuntos de herramientas',
  'settings.agent.toolSetGrantsHelp':
    'Las herramientas directas entran inmediatamente en la solicitud al modelo. Las enrutadas se descubren mediante búsqueda y llamada.',
  'settings.agent.topK': 'Top K',
  'settings.agent.topP': 'Top P',
  'settings.agent.unknownContribution': 'Contribución desconocida',
  'settings.agent.useAgentModel': 'Usar el modelo del agente',
  'settings.agent.useAgentProvider': 'Usar el proveedor del agente',
  'settings.agent.validation.configurationObject':
    'La configuración del agente debe ser un único objeto JSON.',
  'settings.agent.validation.contextWindowRequired':
    'La ventana de contexto es obligatoria al configurar la presión de contexto.',
  'settings.agent.validation.maxIterations': 'Usa un número entero positivo o «sin límite».',
  'settings.agent.validation.model': 'Introduce el ID del modelo de conversación.',
  'settings.agent.validation.overrideModel': 'Un proveedor alternativo requiere un ID de modelo.',
  'settings.agent.validation.provider': 'Selecciona un proveedor configurado.',
  'settings.agent.validation.reserveSmaller':
    'La reserva para la salida debe ser menor que la ventana de contexto.',
  'settings.agent.validation.systemPrompt': 'El prompt del sistema es obligatorio.',
  'settings.agent.validation.toolSelection':
    'Selecciona al menos una herramienta o concede el conjunto completo.',
  'settings.agent.verdict.allow': 'Permitir',
  'settings.agent.verdict.deny': 'Denegar',
  'settings.agent.verdict.escalate': 'Escalar',
} as const);

export { agentMessages };
