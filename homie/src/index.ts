export { loadConfig, resolveModel, getAgentModel, getDataDir } from "./config.js";
export type { HomieConfig, HostConfig, AgentModelConfig } from "./config.js";

export type { LabState, ContainerInfo, ServiceInfo, HostInfo, SpecialistName } from "./types.js";

export { createHomie, createHomieInstance, initSharedServices } from "./orchestrator/homie.js";
export type { HomieInstance, SharedServices } from "./orchestrator/homie.js";

export { createConversationManager } from "./conversations/manager.js";
export type { ConversationManager } from "./conversations/manager.js";
export type { ConversationMeta, ConversationSource, ConversationIndex } from "./conversations/types.js";
export { JsonlLogger } from "./conversations/jsonl-logger.js";

export { runSpecialist } from "./specialists/runner.js";
export type { SpecialistConfig, SpecialistResult } from "./specialists/runner.js";

export { startServer } from "./server/index.js";
export type { ServerConfig } from "./server/index.js";

export { LxdService } from "./services/lxd.js";
export { DockerService } from "./services/docker.js";
export { SshService } from "./services/ssh.js";
