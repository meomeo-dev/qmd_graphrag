export function isResumeTerminalReady(resume) {
  return resume?.nextStage == null &&
    (resume?.status === "ready" || resume?.status === "completed");
}

export function resumePassEventStatus(resume) {
  return isResumeTerminalReady(resume) ? "completed" : "running";
}
