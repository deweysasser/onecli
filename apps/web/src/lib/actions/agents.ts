"use server";

import { revalidatePath } from "next/cache";
import { resolveProjectContext } from "@/lib/actions/resolve-user";
import type {
  SecretMode,
  AgentAppConnectionInput,
} from "@onecli/api/services/agent-service";
import {
  listAgents,
  getDefaultAgent as getDefaultAgentService,
  setDefaultAgent as setDefaultAgentService,
  createAgent as createAgentService,
  deleteAgent as deleteAgentService,
  renameAgent as renameAgentService,
  regenerateAgentToken as regenerateAgentTokenService,
  getAgentSecrets as getAgentSecretsService,
  updateAgentSecretMode as updateAgentSecretModeService,
  updateAgentSecrets as updateAgentSecretsService,
  getAgentAppConnections as getAgentAppConnectionsService,
  updateAgentAppConnections as updateAgentAppConnectionsService,
  updateAgentPolicyMode as updateAgentPolicyModeService,
} from "@onecli/api/services/agent-service";
import { invalidateGatewayCacheForOrg } from "@onecli/api/lib/gateway-invalidate";
import {
  withAudit,
  AUDIT_ACTIONS,
  AUDIT_SERVICES,
} from "@onecli/api/services/audit-service";

export const getAgents = async () => {
  const { projectId } = await resolveProjectContext();
  return listAgents(projectId);
};

export const getDefaultAgent = async () => {
  const { projectId } = await resolveProjectContext();
  return getDefaultAgentService(projectId);
};

export const createAgent = async (name: string, identifier: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => createAgentService(projectId, name, identifier),
    (agent) => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.CREATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId: agent.id, name, identifier },
    }),
  );
};

export const setDefaultAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => setDefaultAgentService(projectId, agentId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, change: "set-default" },
    }),
  );
};

export const deleteAgent = async (agentId: string): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => deleteAgentService(projectId, agentId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.DELETE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};

export const renameAgent = async (
  agentId: string,
  name: string,
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => renameAgentService(projectId, agentId, name),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, name },
    }),
  );
};

export const regenerateAgentToken = async (agentId: string) => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => regenerateAgentTokenService(projectId, agentId),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.REGENERATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId },
    }),
  );
};

export const getAgentSecrets = async (agentId: string) => {
  const { projectId } = await resolveProjectContext();
  return getAgentSecretsService(projectId, agentId);
};

export const updateAgentSecretMode = async (
  agentId: string,
  mode: SecretMode,
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => updateAgentSecretModeService(projectId, agentId, mode),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, secretMode: mode },
    }),
  );
};

export const updateAgentSecrets = async (
  agentId: string,
  secretIds: string[],
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => updateAgentSecretsService(projectId, agentId, secretIds),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, secretCount: secretIds.length },
    }),
  );
};

export const getAgentAppConnections = async (agentId: string) => {
  const { projectId } = await resolveProjectContext();
  return getAgentAppConnectionsService(projectId, agentId);
};

export const updateAgentAppConnections = async (
  agentId: string,
  connections: AgentAppConnectionInput[],
): Promise<void> => {
  const { userId, userEmail, projectId } = await resolveProjectContext();
  return withAudit(
    () => updateAgentAppConnectionsService(projectId, agentId, connections),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, appConnectionCount: connections.length },
    }),
  );
};

export const setAgentPolicyMode = async (
  agentId: string,
  policyMode: "allow" | "deny" | null,
): Promise<void> => {
  const { userId, userEmail, projectId, organizationId } =
    await resolveProjectContext();
  await withAudit(
    () => updateAgentPolicyModeService(projectId, agentId, policyMode),
    () => ({
      projectId,
      userId,
      userEmail,
      action: AUDIT_ACTIONS.UPDATE,
      service: AUDIT_SERVICES.AGENT,
      metadata: { agentId, policyMode },
    }),
  );
  invalidateGatewayCacheForOrg(organizationId);
  revalidatePath("/", "layout");
};
