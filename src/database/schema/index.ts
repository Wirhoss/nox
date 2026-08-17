import { messages } from './messages';
import { sessions } from './sessions';

// Every table in one object: consumed by drizzle({ schema }) and by
// drizzle.config.ts. A new table gets its own module here and a line below.
const schema = { messages, sessions };

export { messages } from './messages';
export { schema };
export { sessions } from './sessions';

export type { MessageRow, MessageRowInsert } from './messages';
export type { SessionRow, SessionRowInsert } from './sessions';
