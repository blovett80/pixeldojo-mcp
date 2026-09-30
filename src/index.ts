/**
 * Public entry — programmatic access to the MCP server. Most consumers
 * use the CLI instead (`npx @pixeldojo/mcp`), but the building blocks
 * are exported here so embedders can build their own MCP host.
 */
export {
  buildServer,
  runStdio,
  PACKAGE_VERSION,
  SERVER_INSTRUCTIONS,
  skillResultToMcpResponse,
  errorToActionableMessage,
} from './server.js';
export type { ServerOptions } from './server.js';
export { makeAttributedClient } from './client.js';
export type { MakeClientOptions } from './client.js';
export { ALL_SKILLS, findSkill, HOSTED_SKILLS, findHostedSkill, toolListing, TOOL_ANNOTATIONS } from './skills/index.js';
export type { SkillModule, SkillContext, SkillResult } from './skills/types.js';
export { redactKeys, redactValue, makeRedactedLogger } from './redact.js';
export {
  pollJobUntilDoneOrHandoff,
  type PollResult,
  type PollableJob,
  type PollOptions,
} from './poll.js';
