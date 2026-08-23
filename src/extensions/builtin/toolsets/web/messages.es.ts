const spanishMessages = Object.freeze({
  'toolSet.description': 'Busca en la web pública y extrae contenido legible de páginas web.',
  'toolSet.name': 'Herramientas web',
  'tools.web_extract.description':
    'Extrae páginas web y devuelve un resultado Markdown separado para cada URL.',
  'tools.web_search.description':
    'Busca en la web pública y devuelve títulos, URL y fragmentos de los resultados.',
  'tools.web_view_image.description':
    'Presenta una URL de imagen pública como contenido visual a un modelo multimodal.',
  'ui.capabilitySurface': 'Superficie de capacidades',
  'ui.capabilitySurfaceHelp':
    'La implementación aportada y las herramientas exactas expuestas cuando un agente recibe este conjunto.',
  'ui.configured': 'CONFIGURADO',
  'ui.credentialValueHint':
    'Si se deja vacío se conserva el valor existente. Los secretos nunca se vuelven a leer.',
  'ui.defaultCharacters': 'Caracteres predeterminados por página',
  'ui.defaultLanguage': 'Idioma predeterminado',
  'ui.defaultLanguageHint': 'Código de idioma de SearXNG, como en, es o all.',
  'ui.defaultResults': 'Resultados predeterminados',
  'ui.disabled': 'DESACTIVADO',
  'ui.enableExtract': 'Activa este endpoint para exponer web_extract.',
  'ui.enableSearch': 'Activa este endpoint para exponer web_search.',
  'ui.exposed': 'EXPUESTA',
  'ui.extract': 'EXTRACCIÓN',
  'ui.extractAuthority': 'RED / LECTURA / EXTRACCIÓN',
  'ui.extractCredential': 'Credencial de extracción',
  'ui.extractCredentialValue': 'Valor de la credencial de extracción',
  'ui.extractEndpoint': 'Endpoint de Crawl4AI',
  'ui.extractEndpointHelp':
    'Extracción de páginas legibles con límites estrictos de lote y tamaño de respuesta.',
  'ui.extractOffline': 'HERRAMIENTA DE EXTRACCIÓN FUERA DE LÍNEA',
  'ui.extractUrl': 'URL del servicio de extracción',
  'ui.extractUrlHint': 'Endpoint HTTP de Crawl4AI que recibe solicitudes de rastreo por lotes.',
  'ui.held': 'RETENIDA',
  'ui.maximumCharacters': 'Máximo de caracteres por página',
  'ui.maximumResults': 'Resultados máximos',
  'ui.maximumUrls': 'Máximo de URL por llamada',
  'ui.newExtractSecretId': 'Nuevo ID de secreto de extracción',
  'ui.newManagedSecret': 'Nuevo secreto gestionado',
  'ui.newSearchSecretId': 'Nuevo ID de secreto de búsqueda',
  'ui.noCredential': 'Sin credencial',
  'ui.noEndpoint': 'No hay ningún endpoint configurado',
  'ui.search': 'BÚSQUEDA',
  'ui.searchAuthority': 'RED / LECTURA / BÚSQUEDA',
  'ui.searchCredential': 'Credencial de búsqueda',
  'ui.searchCredentialValue': 'Valor de la credencial de búsqueda',
  'ui.searchEndpoint': 'Endpoint de SearXNG',
  'ui.searchEndpointHelp':
    'Búsqueda en la web pública con un número limitado de resultados y un idioma predeterminado.',
  'ui.searchOffline': 'HERRAMIENTA DE BÚSQUEDA FUERA DE LÍNEA',
  'ui.searchUrl': 'URL del servicio de búsqueda',
  'ui.searchUrlHint': 'Nox añade /search y solicita los resultados en formato JSON.',
  'ui.secretIdHint':
    'La configuración del conjunto de herramientas guardará este ID, nunca su valor.',
  'ui.surface': 'SUPERFICIE',
  'ui.timeout': 'Tiempo límite (ms)',
  'ui.timeoutHint': 'Si está vacío se usa el valor predeterminado del entorno: 30000 ms.',
  'ui.type': 'Tipo de conjunto de herramientas',
  'ui.validation.chooseSecretId': 'Elige un ID de secreto válido antes de introducir su valor.',
  'ui.validation.configureEndpoint': 'Configura búsqueda, extracción o ambas.',
  'ui.validation.conflictingSecretValues':
    'Ambos endpoints usan este ID de secreto, pero especifican valores diferentes.',
  'ui.validation.defaultExceedsMaximum':
    'El valor predeterminado no puede superar el máximo del endpoint.',
  'ui.validation.defaultLanguageRequired': 'El idioma predeterminado es obligatorio.',
  'ui.validation.httpUrl': 'Introduce una URL HTTP o HTTPS absoluta.',
  'ui.validation.oneToolExposed': 'Al menos una herramienta configurada debe permanecer expuesta.',
  'ui.validation.secretValueRequired': 'Introduce el valor del nuevo secreto gestionado.',
  'ui.validation.useJson':
    'Usa el modo JSON para los tipos de conjuntos de herramientas aportados.',
  'ui.webTools': 'Herramientas web',
} as const);

export { spanishMessages };
