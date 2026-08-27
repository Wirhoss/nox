const spanishMessages = Object.freeze({
  'toolSet.description':
    'Inspecciona y administra la configuración de Nox, sus generaciones y metadatos de secretos.',
  'toolSet.name': 'Configuración',
  'tools.config_create.description': 'Crea una entrada de configuración sin reemplazar otra.',
  'tools.config_delete.description': 'Elimina una entrada cuando nada siga necesitándola.',
  'tools.config_get.description': 'Lee el documento de aplicación o una entrada específica.',
  'tools.config_list.description': 'Lista IDs de una sección de configuración con entradas.',
  'tools.config_reload.description': 'Recarga las secciones montadas permitidas.',
  'tools.config_replace.description': 'Reemplaza por completo una entrada existente.',
  'tools.config_retry.description': 'Reintenta activar la configuración deseada del runtime.',
  'tools.config_revert.description':
    'Restaura el documento anterior a la última activación fallida.',
  'tools.config_schema.description': 'Lee los esquemas autoritativos de configuración.',
  'tools.config_secrets.description': 'Lista metadatos de secretos sin devolver sus valores.',
  'tools.config_status.description': 'Lee el estado de configuración y generaciones del runtime.',
  'tools.config_toolsets.description': 'Inspecciona las herramientas de los toolsets configurados.',
  'tools.config_update_app.description':
    'Reemplaza el documento completo de configuración general.',
  'ui.manageRuntime': 'Administrar activación del runtime',
  'ui.manageRuntimeHelp': 'Expone herramientas para recargar, reintentar y revertir fallos.',
  'ui.readSecretMetadata': 'Leer metadatos de secretos',
  'ui.readSecretMetadataHelp':
    'Expone IDs, estado, referencias y consumidores; los valores nunca pueden leerse.',
  'ui.readSections': 'Secciones legibles',
  'ui.readSectionsHelp': 'Secciones separadas por comas que las herramientas pueden consultar.',
  'ui.writeSections': 'Secciones modificables',
  'ui.writeSectionsHelp': 'Secciones separadas por comas que las herramientas pueden cambiar.',
} as const);

export { spanishMessages };
