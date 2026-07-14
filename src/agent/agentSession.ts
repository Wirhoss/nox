class AgentSession {
  private readonly eventLog = new EventLog<AgentStreamEvent>();

  private context: Context;
  private runner: Runner;
  
  private toolSets: ToolSet[] = [];

  private agentConfig: AgentConfig;
}