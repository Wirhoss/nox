import { accessMessages } from './access';
import { agentMessages } from './agent';
import { auditMessages } from './audit';
import { brokerMessages } from './broker';
import { chatMessages } from './chat';
import { commonMessages } from './common';
import { generalMessages } from './general';
import { secretMessages } from './secrets';
import { sessionMessages } from './sessions';
import { settingsMessages } from './settings';

const messages = Object.freeze({
  ...accessMessages,
  ...agentMessages,
  ...auditMessages,
  ...brokerMessages,
  ...chatMessages,
  ...commonMessages,
  ...generalMessages,
  ...secretMessages,
  ...sessionMessages,
  ...settingsMessages,
});

export { messages };
