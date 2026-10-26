import type { BuildPhaseExecutionState, PlanningStatus } from "./api-client.ts";

type BuildReadinessClient = {
  getBuildPhaseExecutionState(
    projectId: string,
    modelTier: string
  ): Promise<BuildPhaseExecutionState>;
  getPlanningStatus(projectId: string): Promise<PlanningStatus>;
};

export type BuildTasksReadiness = {
  state: BuildPhaseExecutionState;
  planningStatus: PlanningStatus;
  planningComplete: boolean;
  canStart: boolean;
  phaseId?: string;
};

export function evaluateBuildTasksReadiness(
  state: BuildPhaseExecutionState,
  planningStatus: PlanningStatus
): BuildTasksReadiness {
  const runnableTasks = Array.isArray(state.runnable_tasks) ? state.runnable_tasks : [];
  const phaseId = typeof state.current_phase?.id === "string"
    ? state.current_phase.id
    : undefined;
  const pmStepStatus = planningStatus.pm_step_status;
  const planningComplete =
    planningStatus.is_active === false &&
    (pmStepStatus == null || pmStepStatus === "done" || pmStepStatus === "skipped");
  const canStart =
    planningComplete &&
    state.can_start === true &&
    state.current_phase != null &&
    runnableTasks.length > 0 &&
    state.all_completed !== true;

  return { state, planningStatus, planningComplete, canStart, phaseId };
}

export async function getBuildTasksReadiness(
  client: BuildReadinessClient,
  projectId: string,
  modelTier: string,
  retries = 0
): Promise<BuildTasksReadiness> {
  const check = async () => {
    const [planningStatus, state] = await Promise.all([
      client.getPlanningStatus(projectId),
      client.getBuildPhaseExecutionState(projectId, modelTier),
    ]);
    return evaluateBuildTasksReadiness(state, planningStatus);
  };
  let readiness = await check();

  for (let attempt = 0; !readiness.canStart && attempt < retries; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    readiness = await check();
  }

  return readiness;
}

export function buildTasksUnavailableMessage(readiness: BuildTasksReadiness): string {
  const { state } = readiness;
  if (!readiness.planningComplete) {
    return "Build Tasks is not available until planning and the Project Manager step have finished.";
  }
  if (state.all_completed || state.blocking_reason === "all_completed") {
    return "All build tasks are already complete.";
  }
  if (state.blocking_reason === "build_in_progress") {
    return "Build tasks are already running for this project.";
  }
  if (state.blocking_reason === "insufficient_credits") {
    return "Build Tasks is unavailable because the project does not have enough credits.";
  }
  if (state.blocking_reason === "assignment_required") {
    return "Build Tasks is unavailable until tasks are assigned to a build phase.";
  }
  if (state.blocking_reason === "dependencies") {
    return "Build Tasks is unavailable until task dependencies are resolved.";
  }
  if (state.blocking_reason === "needs_attention") {
    return "Build Tasks is unavailable because one or more tasks need attention.";
  }
  if (state.current_phase == null) {
    return "Build Tasks is not available yet because there is no current build phase.";
  }
  if (!Array.isArray(state.runnable_tasks) || state.runnable_tasks.length === 0) {
    return "Build Tasks is not available yet because there are no runnable tasks.";
  }
  return "Build Tasks is not available yet.";
}
