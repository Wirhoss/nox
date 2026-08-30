const spanishMessages = Object.freeze({
  'ui.contradictionDistance': 'Revisión de contradicciones',
  'ui.contradictionDistanceHelp':
    'Cuánto pueden distanciarse dos hechos recordados y aun así presentarse al modelo de extracción como posible contradicción, para retirar una creencia que otra posterior terminó fuera del turno que la terminó. Es el único paso de consolidación que cuesta una llamada al modelo: 0 lo desactiva y valores mayores preguntan por más parejas. Debe superar el umbral de duplicados, porque lo más cercano se funde en lugar de preguntarse.',
  'ui.dream': 'Extracción en segundo plano',
  'ui.dreamHelp':
    'Cuándo puede Nox gastar el modelo de extracción en los turnos que ha guardado. Una pasada empieza cuando hay este número de turnos esperando, o cuando el runtime lleva este tiempo en reposo, o cuando el turno más antiguo alcanza la demora máxima, lo que ocurra primero. Extraer mientras Nox está en reposo evita que el modelo de extracción compita con el que responde, algo que importa sobre todo cuando ambos corren en el mismo hardware local.',
  'ui.embedding': 'Modelo de embeddings',
  'ui.embeddingHelp':
    'Proveedor y modelo que sitúan los hechos recordados en el espacio vectorial. Cambiarlo descarta los vectores almacenados y los reconstruye.',
  'ui.maxDistance': 'Umbral de relevancia',
  'ui.maxDistanceHelp':
    'Cuánto puede alejarse un hecho recordado de la pregunta y aun así recuperarse. Distancia L2 de 0 a 2; más bajo es más estricto, 2 recupera los hechos más cercanos sean o no relevantes. Déjalo vacío para que Nox mida el valor que corresponde al modelo de embeddings elegido.',
  'ui.extraction': 'Modelo de extracción',
  'ui.extractionHelp':
    'Proveedor y modelo que deciden qué merece recordarse de un turno terminado.',
  'ui.mergeDistance': 'Umbral de duplicados',
  'ui.mergeDistanceHelp':
    'Cuánto deben acercarse dos hechos recordados para que Nox los funda en uno, sumando sus testigos y su confianza. Mucho más estricto que el umbral de relevancia, porque fundir dos afirmaciones que solo se parecían destruye una de ellas: el valor por defecto admite reformulaciones, no ideas relacionadas. 0 desactiva la fusión.',
  'ui.maxRecallFacts': 'Máximo de hechos recuperados',
  'ui.maxRecallFactsHelp':
    'Número máximo de hechos recordados que se colocan en contexto para una solicitud al modelo.',
} as const);

export { spanishMessages };
