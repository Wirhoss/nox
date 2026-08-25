const spanishMessages = Object.freeze({
  'toolSet.description':
    'Busca en la web pública, extrae páginas como archivos duraderos y controla un navegador real.',
  'toolSet.name': 'Herramientas web',
  'tools.browser_click.description':
    'Hace clic en un elemento de una página abierta y devuelve la página resultante.',
  'tools.browser_close.description': 'Cierra una pestaña abierta.',
  'tools.browser_images.description': 'Lista las imágenes a las que apunta una página abierta.',
  'tools.browser_links.description': 'Lista los enlaces a los que apunta una página abierta.',
  'tools.browser_navigate.description': 'Lleva una pestaña abierta a otra URL.',
  'tools.browser_open.description':
    'Abre una pestaña del navegador y devuelve su tabId junto con la página.',
  'tools.browser_press.description': 'Pulsa una tecla en una página abierta.',
  'tools.browser_screenshot.description': 'Captura una página abierta como artefacto de imagen.',
  'tools.browser_scroll.description': 'Desplaza una página abierta.',
  'tools.browser_snapshot.description':
    'Lee una página abierta como una instantánea de accesibilidad con refs de elementos.',
  'tools.browser_type.description': 'Escribe texto en un elemento de una página abierta.',
  'tools.browser_wait.description': 'Espera a un elemento o a un retardo en una página abierta.',
  'tools.web_extract.description':
    'Extrae páginas web públicas como archivos duraderos — HTML limpio, las imágenes de la página y, si se pide, una captura, un PDF o Markdown.',
  'tools.web_search.description':
    'Busca en la web pública y devuelve títulos, URL y fragmentos de los resultados.',
  'ui.camoufox.snapshot': 'Caracteres de instantánea en línea',
  'ui.camoufox.snapshotHelp':
    'Las instantáneas de accesibilidad más largas se publican como archivo y solo su inicio queda en la conversación.',
  'ui.camoufox.userId': 'Propietario de la sesión del navegador',
  'ui.camoufox.userIdHelp': 'El usuario de camofox con el que navega esta instancia de Nox.',
  'ui.crawl4ai.captures': 'Capturas predeterminadas',
  'ui.crawl4ai.capturesHelp': 'Lo que devuelve cada página cuando el agente no pide otra cosa.',
  'ui.crawl4ai.waitUntil': 'Esperar hasta',
  'ui.crawl4ai.waitUntilHelp': 'Cuán asentada debe estar una página antes de capturarla.',
  'ui.credential': 'Credencial',
  'ui.credentialHelp':
    'El secreto gestionado que guarda el token de este servicio. Los valores nunca se vuelven a leer.',
  'ui.defaultResults': 'Resultados predeterminados',
  'ui.maximumResults': 'Resultados máximos',
  'ui.maximumUrls': 'Máximo de URL por llamada',
  'ui.playwright.browser': 'Motor del navegador',
  'ui.playwright.browserHelp':
    'Chromium, Firefox o WebKit. El contenedor local incluye Chromium; los demás necesitan un endpoint remoto.',
  'ui.playwright.credentialHelp':
    'Token bearer opcional que solo se envía al conectar con un endpoint remoto de Playwright.',
  'ui.playwright.executablePath': 'Ejecutable del navegador',
  'ui.playwright.executablePathHelp':
    'Ejecutable local opcional. Vacío usa Chromium del contenedor o un navegador instalado por Playwright.',
  'ui.playwright.headless': 'Sin interfaz gráfica',
  'ui.playwright.headlessHelp': 'Ejecuta un navegador iniciado localmente sin una ventana visible.',
  'ui.playwright.snapshot': 'Caracteres de instantánea en línea',
  'ui.playwright.snapshotHelp':
    'Las instantáneas de accesibilidad más largas se publican como archivo y solo su inicio queda en la conversación.',
  'ui.playwright.wsEndpoint': 'Endpoint WebSocket de Playwright',
  'ui.playwright.wsEndpointHelp':
    'Endpoint ws:// o wss:// opcional de browserType.launchServer. Vacío inicia el navegador localmente.',
  'ui.searxng.engines': 'Motores',
  'ui.searxng.enginesHelp':
    'Motores de SearXNG separados por comas. Vacío usa el conjunto propio de la instancia.',
  'ui.searxng.language': 'Idioma predeterminado',
  'ui.searxng.languageHelp': 'Código de idioma de SearXNG, como en, es o all.',
  'ui.searxng.safeSearch': 'Búsqueda segura',
  'ui.searxng.safeSearchHelp': '0 desactivada, 1 moderada, 2 estricta.',
  'ui.serviceUrl': 'URL del servicio',
  'ui.slot.browser': 'Navegador',
  'ui.slot.browserHelp': 'Llena esta ranura para exponer la herramienta browser.',
  'ui.slot.extract': 'Extracción',
  'ui.slot.extractHelp': 'Llena esta ranura para exponer web_extract.',
  'ui.slot.search': 'Búsqueda',
  'ui.slot.searchHelp': 'Llena esta ranura para exponer web_search.',
  'ui.timeout': 'Tiempo límite (ms)',
} as const);

export { spanishMessages };
