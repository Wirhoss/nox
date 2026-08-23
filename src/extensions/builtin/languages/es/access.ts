const accessMessages = Object.freeze({
  'access.authenticated.description': 'Acceso aceptado. Abriendo la superficie activa.',
  'access.authenticated.eyebrow': 'NOX // CONTROL DE ACCESO',
  'access.authenticated.status': 'Autorizado',
  'access.authenticated.title': 'Bienvenido, {username}',
  'access.checking.description':
    'Contactando con el entorno local y consultando su estado real de registro.',
  'access.checking.eyebrow': 'NOX // INICIALIZACIÓN DEL ENLACE',
  'access.checking.reading': 'Leyendo',
  'access.checking.status': 'Conectando',
  'access.checking.title': 'Estableciendo enlace con el nodo',
  'access.frame.accessSurface': 'SUPERFICIE DE ACCESO NOX',
  'access.frame.identity': 'Identidad',
  'access.frame.localFirst': 'Local primero',
  'access.frame.localNode': 'NODO LOCAL',
  'access.frame.manifesto': 'Una máquina privada.\nDespierta cuando tú no lo estás.',
  'access.frame.mode': 'Modo',
  'access.frame.ownerOperated': 'GESTIONADO POR SU PROPIETARIO',
  'access.frame.personalRuntime': 'Entorno personal',
  'access.frame.singleOperator': 'Operador único',
  'access.frame.surface': 'Superficie',
  'access.frame.webAccess': 'Acceso web',
  'access.registration.description':
    'Crea la única identidad de operador que será propietaria de esta instalación.',
  'access.registration.eyebrow': 'NOX // PRIMERA RECLAMACIÓN',
  'access.registration.status': 'Nodo sin reclamar',
  'access.registration.title': 'Reclama esta máquina',
  'access.signedOut.description': 'Identifícate para entrar en esta instalación local de Nox.',
  'access.signedOut.eyebrow': 'NOX // CONTROL DE ACCESO',
  'access.signedOut.status': 'Nodo en línea',
  'access.signedOut.title': 'Volver a Nox',
  'access.unavailable.description':
    'La superficie web está activa, pero el entorno de Nox no ha respondido.',
  'access.unavailable.eyebrow': 'NOX // FALLO DE CONEXIÓN',
  'access.unavailable.noticeBody':
    'Comprueba que el contenedor esté en ejecución y que su superficie HTTP sea accesible.',
  'access.unavailable.noticeTitle': 'El entorno no ha respondido',
  'access.unavailable.status': 'Nodo no disponible',
  'access.unavailable.title': 'Esperando al nodo Nox',
  'auth.error.alreadyRegistered':
    'Otra solicitud ha reclamado este Nox. Inicia sesión con la identidad registrada.',
  'auth.error.invalidCode':
    'El código de reclamación no es válido o ha caducado. Consulta los registros actuales del contenedor de Nox.',
  'auth.error.invalidCredentials': 'La identidad o la contraseña son incorrectas.',
  'auth.error.rejectedUnexpectedly':
    'Nox ha rechazado la solicitud de forma inesperada. Inténtalo de nuevo.',
  'auth.error.unavailable':
    'El nodo Nox ha dejado de responder. Comprueba el entorno e inténtalo de nuevo.',
  'auth.error.unexpectedResponse':
    'Nox ha devuelto una respuesta inesperada. Inténtalo de nuevo o abre el diagnóstico.',
  'auth.field.claimCode': 'Código de reclamación',
  'auth.field.confirmPassword': 'Confirmar contraseña',
  'auth.field.identity': 'Identidad',
  'auth.field.password': 'Contraseña',
  'auth.login.accessDenied': 'Acceso denegado',
  'auth.login.passwordPlaceholder': 'Introduce tu contraseña',
  'auth.login.registrationClosedBody':
    'Este Nox acaba de ser reclamado. Inicia sesión con la identidad registrada.',
  'auth.login.registrationClosedTitle': 'Registro cerrado',
  'auth.login.submit': 'Entrar en Nox',
  'auth.registration.claimCodeHint':
    'Aparece en los registros actuales del contenedor de Nox. Al reiniciar se crea un código nuevo.',
  'auth.registration.confirmPasswordPlaceholder': 'Repite tu contraseña',
  'auth.registration.identityHint': 'Solo letras, dígitos, puntos, guiones y guiones bajos.',
  'auth.registration.passwordPlaceholder': '8 caracteres como mínimo',
  'auth.registration.rejected': 'Reclamación rechazada',
  'auth.registration.submit': 'Reclamar este Nox',
  'auth.validation.claimCodeRequired':
    'Introduce el código de reclamación mostrado por el contenedor de Nox.',
  'auth.validation.confirmPasswordRequired': 'Confirma la contraseña.',
  'auth.validation.identityCharacters': 'Usa letras, dígitos, puntos, guiones o guiones bajos.',
  'auth.validation.identityMax': 'La identidad no puede superar los 64 caracteres.',
  'auth.validation.identityMin': 'La identidad debe contener al menos 3 caracteres.',
  'auth.validation.passwordMax': 'La contraseña no puede superar los 200 caracteres.',
  'auth.validation.passwordMin': 'La contraseña debe contener al menos 8 caracteres.',
  'auth.validation.passwordsMismatch': 'Las contraseñas no coinciden.',
} as const);

export { accessMessages };
