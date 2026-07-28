import { Context } from "../context";
import { nanoid } from 'nanoid'

interface SessionOptions {
  sessionId?: string;
}

class Session {
  private readonly sessionId: string;

  private context: Context;

  constructor(database: Database, sessionOptions: SessionOptions) {
    const { sessionId } = sessionOptions;
    this.sessionId = sessionId ?? nanoid();
  }


  private initSession(sessionId: string) {

  }
}