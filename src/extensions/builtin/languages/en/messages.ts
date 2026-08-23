import { accessMessages } from './access';
import { agentMessages } from './agent';
import { brokerMessages } from './broker';
import { chatMessages } from './chat';
import { commonMessages } from './common';
import { generalMessages } from './general';
import { secretMessages } from './secrets';
import { settingsMessages } from './settings';

/** Core English copy. Feature-extension copy lives with the feature itself. */
const messages = Object.freeze({
  ...accessMessages,
  ...agentMessages,
  ...brokerMessages,
  ...chatMessages,
  ...commonMessages,
  ...generalMessages,
  ...secretMessages,
  ...settingsMessages,
});

export { messages };
