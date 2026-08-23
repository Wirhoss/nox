const secretMessages = Object.freeze({
  'settings.secrets.awaitingValue': 'esperando un valor',
  'settings.secrets.blankHint':
    'El campo está vacío de forma intencionada aunque ya exista un valor.',
  'settings.secrets.configuredReferences': 'REFERENCIAS CONFIGURADAS',
  'settings.secrets.configuredReferencesHelp':
    'Cada entrada configurada que menciona este ID. Un solo valor sirve para todas; así se ve la reutilización de una credencial entre entradas.',
  'settings.secrets.consumers': 'CONSUMIDORES',
  'settings.secrets.created': 'CREADO',
  'settings.secrets.delete': 'Eliminar secreto',
  'settings.secrets.deleteQuestion': '¿Eliminar el secreto gestionado?',
  'settings.secrets.deleteWarning':
    'El valor no se puede recuperar. Los consumidores en ejecución pueden conservar su copia actual, pero el próximo reinicio fallará si la configuración sigue haciendo referencia a este ID.',
  'settings.secrets.id': 'ID del secreto',
  'settings.secrets.idHint':
    'Referencia estable usada en la configuración, por ejemplo OPENAI_API_KEY.',
  'settings.secrets.managed': 'SEGURIDAD // SECRETOS GESTIONADOS',
  'settings.secrets.new': 'Nuevo secreto',
  'settings.secrets.newValue': 'Nuevo valor',
  'settings.secrets.noRunningConsumer':
    'Ninguna contribución en ejecución ha resuelto este secreto.',
  'settings.secrets.noneKnown': 'No hay secretos conocidos',
  'settings.secrets.noneKnownHelp':
    'Ninguna configuración menciona una credencial y no se ha almacenado ninguna. Guarda una aquí y después referencia su ID desde una entrada de proveedor, conjunto de herramientas o bróker.',
  'settings.secrets.notSet': 'SIN DEFINIR',
  'settings.secrets.notStored': 'NO ALMACENADO',
  'settings.secrets.operationRefused': 'Operación sobre el secreto rechazada',
  'settings.secrets.originMany': 'usado por {count} entradas configuradas',
  'settings.secrets.originOne': 'usado por {location}',
  'settings.secrets.originUnreferenced': 'almacenado, sin referencias',
  'settings.secrets.referencesRemain.one':
    'El ID seguirá apareciendo como no definido: {count} entrada configurada todavía lo menciona.',
  'settings.secrets.referencesRemain.other':
    'El ID seguirá apareciendo como no definido: {count} entradas configuradas todavía lo mencionan.',
  'settings.secrets.replaceCredential': 'Reemplazar credencial',
  'settings.secrets.replaceValue': 'Reemplazar valor',
  'settings.secrets.runtimeReferences': 'REFERENCIAS DEL ENTORNO',
  'settings.secrets.runtimeReferencesHelp':
    'Los consumidores que ya tienen un identificador conservan su copia hasta el reinicio.',
  'settings.secrets.store': 'Guardar secreto',
  'settings.secrets.storeCredential': 'Guardar credencial',
  'settings.secrets.storeStatus': 'ESTADO DE ALMACENAMIENTO',
  'settings.secrets.stored': 'ALMACENADO',
  'settings.secrets.storedRestart':
    'Uno o más consumidores en ejecución conservarán el valor anterior hasta que Nox se reinicie.',
  'settings.secrets.storedTitle': 'Secreto guardado',
  'settings.secrets.updated': 'ACTUALIZADO',
  'settings.secrets.updatedAt': 'actualizado el {date}',
  'settings.secrets.usedBy': 'Usado por',
  'settings.secrets.valueAccepted': 'El valor ha sido aceptado.',
  'settings.secrets.valuePlaceholder': 'El valor no volverá a mostrarse',
  'settings.secrets.valueRequired': 'El valor de un secreto no puede estar vacío.',
  'settings.secrets.writeOnly': 'VALOR DE SOLO ESCRITURA',
  'settings.secrets.writeOnlyHelp':
    'Nox cifra este valor en reposo. El navegador puede escribirlo, pero ninguna API puede volver a recuperarlo.',
} as const);

export { secretMessages };
