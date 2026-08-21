import { conversations } from './conversations';
import { decisions } from './decisions';
import { messages } from './messages';
import { sessions } from './sessions';

// Every table in one object: consumed by drizzle({ schema }) and by
// drizzle.config.ts. A new table gets its own module here and a line below.
const schema = { conversations, decisions, messages, sessions };

export { conversations } from './conversations';
export { decisions } from './decisions';
export { messages } from './messages';
export { schema };
export { sessions } from './sessions';

export type { ConversationRow, ConversationRowInsert } from './conversations';
export type { DecisionRow, DecisionRowInsert } from './decisions';
export type { MessageRow, MessageRowInsert } from './messages';
export type { SessionRow, SessionRowInsert } from './sessions';
