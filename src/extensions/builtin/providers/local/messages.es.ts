const spanishMessages = Object.freeze({
  'ui.cacheDirectory': 'Directorio de caché de pesos',
  'ui.cacheDirectoryHelp':
    'Dónde se guardan los pesos descargados. Vacío, el runtime usa su propia caché.',
  'ui.model': 'Modelo',
  'ui.modelHelp': 'Repositorio del que se descargan los pesos la primera vez que se usa el modelo.',
  'ui.precision': 'Precisión de los pesos',
  'ui.precisionHelp':
    'Menor precisión carga más rápido y usa menos memoria, a cambio de algo de calidad.',
  'ui.threads': 'Hilos de CPU',
  'ui.threadsHelp':
    'Bajo a propósito: estos hilos comparten la máquina con el servidor que responde peticiones.',
} as const);

export { spanishMessages };
